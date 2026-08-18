#!/usr/bin/env node
/**
 * Solver for the Aliyun (阿里云) puzzle-slider CAPTCHA shown by gigab2b.com.
 *
 * How the CAPTCHA works (reverse-engineered from the live site):
 *   - The background image (`#aliyunCaptcha-img`, 296x200 natural, shown at
 *     300x200) has a white jigsaw-shaped notch cut out of it.
 *   - The draggable piece (`#aliyunCaptcha-puzzle`, 52x200, from `shadow.png`)
 *     carries the landscape content that was cut out, inside a semi-transparent
 *     jigsaw mask.
 *   - The slider knob (`#aliyunCaptcha-sliding-slider`, 40x40) does NOT move
 *     1:1 with the piece: there is a fixed parallax
 *         piece = a*s^2 + b*s   (a = 3/845, b = 1/13, s = knob travel in px)
 *     which was measured from the live drag handler.
 *   - The server validates the knob travel distance against the notch position.
 *
 * Solver strategy:
 *   1. Locate the notch by scoring every horizontal offset of the piece's alpha
 *      mask against the background's brightness anomaly (the notch is brighter
 *      than its surroundings), then verify with the notch's sharp vertical edges.
 *   2. Invert the parallax to compute the knob travel and drag with a
 *      human-like (segmented, irregular) trajectory.
 *   3. Detect success/failure from the status text / popup visibility and retry
 *      on a fresh puzzle after a failure.
 */

const POPUP = "#aliyunCaptcha-window-popup";
const BG_IMG = "#aliyunCaptcha-img";
const PIECE = "#aliyunCaptcha-puzzle";
const SLIDER = "#aliyunCaptcha-sliding-slider";
const SLIDER_TEXT = "#aliyunCaptcha-sliding-text";
const REFRESH = "#aliyunCaptcha-btn-refresh";
const OVERLAY = "#aliyunCaptcha-overlay";

const rnd = (min, max) => min + Math.random() * (max - min);

/** Run `fn` but reject if it takes longer than `ms`. */
async function withTimeout(fn, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForFreshPuzzle(page, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const bg = document.querySelector("#aliyunCaptcha-img");
      const piece = document.querySelector("#aliyunCaptcha-puzzle");
      const overlay = document.querySelector("#aliyunCaptcha-overlay");
      return {
        bgReady: bg ? bg.complete && bg.naturalWidth > 0 : false,
        pieceReady: piece ? piece.complete && piece.naturalWidth > 0 : false,
        overlayHidden: overlay ? getComputedStyle(overlay).display === "none" : true,
        pieceLeft: piece ? parseFloat(piece.style.left) || 0 : 0,
      };
    });
    if (state.bgReady && state.pieceReady && state.overlayHidden && state.pieceLeft <= 0.5) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/** Convert an image `src` into a same-origin-safe data URI (avoids canvas taint). */
async function toDataURI(context, src) {
  if (!src) return null;
  if (src.startsWith("data:")) return src;
  try {
    const resp = await context.request.get(src);
    if (!resp.ok()) return null;
    const body = await resp.body();
    const mime = resp.headers()["content-type"] || "image/png";
    return `data:${mime};base64,${body.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Locate the notch and return the target `left` (CSS px) the piece element must
 * reach so its opaque content covers the notch.
 */
async function detectPieceTarget(page, context) {
  const srcs = await page.evaluate(() => ({
    bg: document.querySelector("#aliyunCaptcha-img")?.src || "",
    piece: document.querySelector("#aliyunCaptcha-puzzle")?.src || "",
  }));
  const bgURI = await toDataURI(context, srcs.bg);
  const pieceURI = await toDataURI(context, srcs.piece);
  if (!bgURI || !pieceURI) return null;

  return page.evaluate(async ({ bgURI, pieceURI }) => {
    const loadImg = (uri) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = uri;
    });
    const bgImg = await loadImg(bgURI);
    const pieceImg = await loadImg(pieceURI);
    if (!bgImg || !pieceImg) return null;

    const W = 300, H = 200, PW = 52, PH = 200;
    const draw = (img, w, h) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h);
    };
    const bg = draw(bgImg, W, H);
    const piece = draw(pieceImg, PW, PH);

    // Piece opaque silhouette.
    const pMask = new Float32Array(PW * PH);
    let px0 = PW, px1 = -1, py0 = PH, py1 = -1;
    for (let y = 0; y < PH; y++) {
      for (let x = 0; x < PW; x++) {
        if (piece.data[(y * PW + x) * 4 + 3] > 100) {
          pMask[y * PW + x] = 1;
          if (x < px0) px0 = x;
          if (x > px1) px1 = x;
          if (y < py0) py0 = y;
          if (y > py1) py1 = y;
        }
      }
    }
    if (px1 <= px0 || py1 <= py0) return null;
    const pieceW = px1 - px0 + 1;
    const contentCenter = (px0 + px1) / 2;

    // Background luminance, local mean and brightness anomaly.
    const lum = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) lum[i] = 0.299 * bg.data[i * 4] + 0.587 * bg.data[i * 4 + 1] + 0.114 * bg.data[i * 4 + 2];
    const R = 9;
    const localMean = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0, n = 0;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && xx < W && yy >= 0 && yy < H) { s += lum[yy * W + xx]; n++; }
          }
        }
        localMean[y * W + x] = s / n;
      }
    }
    const anomaly = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) anomaly[i] = lum[i] - localMean[i];

    // 1) Brightness-anomaly matched filter (notch = bright blob of the mask shape).
    const anomalyScores = [];
    for (let x = 0; x <= W - PW; x++) {
      let sum = 0, n = 0;
      for (let py = 0; py < PH; py++) {
        for (let px = 0; px < PW; px++) {
          if (pMask[py * PW + px]) { sum += anomaly[py * W + (x + px)]; n++; }
        }
      }
      anomalyScores.push({ x, score: n ? sum / n : 0 });
    }
    const smooth = (arr, r) => arr.map((_, i) => {
      let s = 0, n = 0;
      for (let j = i - r; j <= i + r; j++) if (j >= 0 && j < arr.length) { s += arr[j].score; n++; }
      return { x: arr[i].x, score: s / n };
    });
    const smoothed = smooth(anomalyScores, 2);
    const sorted = [...smoothed].sort((a, b) => b.score - a.score);
    const anomalyPeak = sorted[0].x;

    // 2) Edge verification: the notch's left edge is a sharp vertical edge in
    //    the piece's y-band; the notch width must match the piece width.
    const y0 = Math.max(0, py0 - 6), y1 = Math.min(H, py1 + 6);
    const colEdge = new Float32Array(W);
    for (let y = y0; y < y1; y++) {
      for (let x = 1; x < W - 1; x++) colEdge[x] += Math.abs(lum[y * W + x + 1] - lum[y * W + x - 1]);
    }
    const colEdgeS = smooth(colEdge.map((v, x) => ({ x, score: v })), 2);
    const peaks = [];
    for (let x = 3; x < W - 3; x++) {
      if (colEdgeS[x].score > colEdgeS[x - 1].score && colEdgeS[x].score >= colEdgeS[x + 1].score) {
        peaks.push({ x, v: colEdgeS[x].score });
      }
    }
    peaks.sort((a, b) => b.v - a.v);

    // Notch = pair of strong edges ~pieceW apart; interior should be bright.
    let notch = null;
    for (let i = 0; i < peaks.length; i++) {
      for (let j = i + 1; j < peaks.length; j++) {
        const a = peaks[i], b = peaks[j];
        const dx = Math.abs(b.x - a.x);
        if (dx < pieceW - 8 || dx > pieceW + 8) continue;
        const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
        let lumSum = 0, n = 0;
        for (let x = left + 3; x < right - 3; x++) { lumSum += lum[(py0 + py1 >> 1) * W + x]; n++; }
        const avgLum = n ? lumSum / n : 0;
        const score = (a.v + b.v) * (avgLum / 255);
        if (!notch || score > notch.score) notch = { left, right, center: (left + right) / 2, score };
      }
    }

    let target;
    if (notch) {
      // Center alignment, using the piece's own content center.
      target = notch.center - contentCenter;
      // If the anomaly peak agrees closely, prefer it (it tracks the full
      // silhouette including the jigsaw knob/socket).
      if (Math.abs(anomalyPeak - target) <= 6) target = anomalyPeak;
    } else {
      target = anomalyPeak;
    }

    const confidence = sorted[0].score;
    const margin = sorted[0].score - sorted[1].score;
    return {
      target: Math.max(0, Math.min(W - PW, target)),
      confidence,
      margin,
      anomalyPeak,
      notch: notch ? { left: notch.left, right: notch.right, center: notch.center } : null,
      piece: { px0, px1, contentCenter },
    };
  }, { bgURI, pieceURI });
}

/** Invert the measured parallax: knob travel for a target piece `left`. */
function knobTravelForPiece(pieceLeft) {
  const a = 3 / 845;
  const b = 1 / 13;
  if (pieceLeft <= 0) return 0;
  const s = (-b + Math.sqrt(b * b + 4 * a * pieceLeft)) / (2 * a);
  return Math.max(0, Math.min(260, s));
}

/**
 * Drag the knob to `endX` in a few variable-speed segments. Each segment is a
 * single `mouse.move(..., { steps })` call so the captcha handler is not hit by
 * hundreds of separate round-trips (which both stalls and looks robotic).
 */
async function dragToTarget(page, target) {
  const box = await withTimeout(() => page.evaluate(() => {
    const s = document.querySelector("#aliyunCaptcha-sliding-slider");
    const b = document.querySelector("#aliyunCaptcha-img-box");
    const sb = s.getBoundingClientRect();
    const bb = b.getBoundingClientRect();
    return {
      knobX: sb.x + sb.width / 2,
      knobY: sb.y + sb.height / 2,
      trackLeft: bb.x,
      trackRight: bb.x + bb.width,
      knobHalf: sb.width / 2,
    };
  }), 8000, "读取滑块位置");

  const travel = knobTravelForPiece(target);
  const clampX = (x) => Math.max(box.trackLeft + box.knobHalf, Math.min(box.trackRight - box.knobHalf, x));
  const endX = clampX(box.knobX + travel);

  // Ensure a clean mouse state (previous attempt may have left the button down).
  await page.mouse.up().catch(() => {});
  await page.mouse.move(box.knobX, box.knobY);
  await page.mouse.down();
  await page.waitForTimeout(rnd(120, 320));

  // A few variable-speed segments, each a single interpolated move (few round-trips).
  const segments = 3 + Math.floor(rnd(0, 2));
  for (let i = 1; i <= segments; i++) {
    const progress = i / segments;
    const targetX = clampX(box.knobX + travel * (progress + rnd(-0.03, 0.03)));
    await withTimeout(
      () => page.mouse.move(targetX, box.knobY + rnd(-1.5, 1.5), { steps: 3 + Math.floor(rnd(0, 4)) }),
      15000,
      "拖动滑块",
    );
    await page.waitForTimeout(rnd(40, 130));
  }
  await page.mouse.move(endX, box.knobY);
  await page.waitForTimeout(rnd(90, 240));
  await page.mouse.up();

  try {
    return await withTimeout(() => page.evaluate(() => parseFloat(document.querySelector("#aliyunCaptcha-puzzle")?.style.left) || 0), 8000, "读取滑块块位置");
  } catch (error) {
    // The page may navigate on success before we read the position.
    if (/Execution context was destroyed|navigation/i.test(error.message || "")) return null;
    throw error;
  }
}

async function captchaOutcome(page) {
  try {
    return await page.evaluate(() => {
      const text = document.querySelector("#aliyunCaptcha-sliding-text");
      const popup = document.querySelector("#aliyunCaptcha-window-popup");
      const t = (text && text.textContent || "").trim().toLowerCase();
      return {
        text: t,
        popupVisible: popup ? getComputedStyle(popup).display !== "none" : false,
        failed: /fail|again|retry|try|timeout|incorrect/i.test(t),
      };
    });
  } catch (error) {
    // A successful verification navigates the page away, destroying the context.
    if (/Execution context was destroyed|navigation|Target closed/i.test(error.message || "")) {
      return { text: "", popupVisible: false, failed: false };
    }
    throw error;
  }
}

async function refreshCaptcha(page) {
  await page.evaluate(() => document.querySelector("#aliyunCaptcha-btn-refresh")?.click()).catch(() => {});
}

/**
 * Attempt to solve the slider captcha. Resolves true once the popup closes.
 * Returns false after exhausting attempts (caller should fall back to manual).
 */
export async function solveSliderCaptcha(page, { maxAttempts = 8, log = console.log } = {}) {
  const context = page.context();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!(await waitForFreshPuzzle(page))) {
      log(`[验证码] 第 ${attempt} 次：等待新拼图超时`);
      await page.waitForTimeout(800);
      continue;
    }

    const detection = await detectPieceTarget(page, context);
    if (!detection) {
      log(`[验证码] 第 ${attempt} 次：无法识别缺口，刷新重试`);
      await refreshCaptcha(page);
      await page.waitForTimeout(1500);
      continue;
    }

    log(`[验证码] 第 ${attempt} 次：目标 ${detection.target.toFixed(1)}px（异常峰值 ${detection.anomalyPeak}，置信度 ${detection.confidence.toFixed(2)}，缺口 ${detection.notch ? `${detection.notch.left}..${detection.notch.right}` : "无"}）`);
    try {
      const finalPiece = await dragToTarget(page, detection.target);
      log(`[验证码] 第 ${attempt} 次：拖动结束，滑块块位置 ${finalPiece?.toFixed(1) ?? "?"}px`);
    } catch (error) {
      log(`[验证码] 第 ${attempt} 次：拖动异常（${error.message}），刷新重试`);
      await refreshCaptcha(page);
      await page.waitForTimeout(1200);
      continue;
    }

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const outcome = await captchaOutcome(page);
      if (!outcome.popupVisible) {
        log(`[验证码] 第 ${attempt} 次：验证通过（弹窗已关闭）`);
        return true;
      }
      if (outcome.failed) {
        log(`[验证码] 第 ${attempt} 次：验证失败（${outcome.text || "未知"}），刷新重试`);
        break;
      }
      await page.waitForTimeout(300);
    }

    await refreshCaptcha(page);
    await page.waitForTimeout(1200);
  }
  return false;
}
