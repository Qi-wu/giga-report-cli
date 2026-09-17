#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dateParts, loadConfig } from "./giga-config.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const WISHLIST_URL = "https://www.gigab2b.com/index.php?route=account/wishlist";
const DOWNLOAD_CENTER_URL = "https://www.gigab2b.com/index.php?route=account/download_central";
const DEFAULT_PROFILE_DIR = path.resolve("work", "giga-playwright-profile");

function parseArgs(argv) {
  const options = {
    configPath: "giga-report.json",
    baseDir: null,
    profileDir: DEFAULT_PROFILE_DIR,
    headed: true,
    force: false,
    dryRun: false,
    timeoutMinutes: 20,
    cdpUrl: "http://127.0.0.1:9224",
    resumeFilename: null,
    resumeTime: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config-path") options.configPath = argv[++i];
    else if (arg === "--base-dir") options.baseDir = argv[++i];
    else if (arg === "--profile-dir") options.profileDir = path.resolve(argv[++i]);
    else if (arg === "--headless") options.headed = false;
    else if (arg === "--force") options.force = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--timeout-minutes") options.timeoutMinutes = Number(argv[++i]);
    else if (arg === "--cdp-url") options.cdpUrl = argv[++i];
    else if (arg === "--resume-filename") options.resumeFilename = argv[++i];
    else if (arg === "--resume-time") options.resumeTime = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0) {
    throw new Error("--timeout-minutes 必须是正数");
  }
  if (Boolean(options.resumeFilename) !== Boolean(options.resumeTime)) {
    throw new Error("--resume-filename 和 --resume-time 必须同时提供");
  }
  return options;
}

function printHelp() {
  console.log(String.raw`
下载 GIGA 基础产品报表

用法:
  .\giga-report.ps1 [参数]

参数:
  --config-path <文件>    JSON 配置文件，默认 giga-report.json
  --force                 即使目标日期已有有效报表也继续下载
  --headless              无界面运行（首次登录或验证码时不要使用）
  --dry-run               只检查环境、登录状态和页面，不提交任务
  --base-dir <目录>       覆盖 JSON 中的下载根路径
  --profile-dir <目录>    Playwright 持久化浏览器资料目录
  --timeout-minutes <数>  等待报表生成的最长分钟数，默认 20
  --cdp-url <URL>          接管已登录普通 Chrome，默认 http://127.0.0.1:9224
`);
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath).on("data", (chunk) => hash.update(chunk)).on("end", resolve).on("error", reject);
  });
  return hash.digest("hex");
}

async function validateXlsx(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 0);
    if (!magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error("文件不是有效的 XLSX/ZIP 格式");
  } finally {
    await handle.close();
  }
  const stat = await fsp.stat(filePath);
  if (stat.size <= 0) throw new Error("下载文件大小为 0");
  return stat.size;
}

async function findExistingValidReport(destinationDir) {
  try {
    const names = await fsp.readdir(destinationDir);
    for (const name of names) {
      if (!name.startsWith("产品信息下载_基础") || !name.toLowerCase().endsWith(".xlsx")) continue;
      const candidate = path.join(destinationDir, name);
      try {
        await validateXlsx(candidate);
        return candidate;
      } catch {
        // Ignore incomplete or invalid leftovers.
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return null;
}

async function uniqueVisible(locator, description) {
  const candidates = await locator.all();
  const visibleIndexes = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (await candidates[index].isVisible()) visibleIndexes.push(index);
  }
  if (visibleIndexes.length !== 1) {
    throw new Error(`${description} 应唯一可见，实际数量: ${visibleIndexes.length}`);
  }
  return locator.nth(visibleIndexes[0]);
}

async function isLoggedIn(page) {
  const passwordVisible = await page.locator('input[type="password"],input[placeholder="Password" i]')
    .first().isVisible().catch(() => false);
  return !page.url().includes("route=account/login") && !passwordVisible;
}

async function fillFirstUnique(page, selectors, value, description) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const candidates = await locator.all();
    const visibleIndexes = [];
    for (let index = 0; index < candidates.length; index += 1) {
      if (await candidates[index].isVisible()) visibleIndexes.push(index);
    }
    if (visibleIndexes.length === 1) {
      await locator.nth(visibleIndexes[0]).fill(value);
      return true;
    }
  }
  return false;
}

async function waitForManualLogin(page, message, timeoutMs = 10 * 60_000) {
  console.log(`[等待] ${message}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function ensureLoggedIn(page) {
  if (!page.url().includes("route=account/wishlist")) {
    await page.goto(WISHLIST_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  if (await isLoggedIn(page)) return;
  throw new Error("普通 Chrome 尚未登录 GIGA。请先运行 open-giga-login.ps1，在该窗口完成登录后再运行下载脚本。");
}

async function getWishlistCount(page) {
  const deadline = Date.now() + 60_000;
  let match;
  while (Date.now() < deadline) {
    const text = await page.locator("body").innerText();
    match = text.match(/全部已收藏\s*\(\s*(\d+)\s*\)/);
    if (match) break;
    await page.waitForTimeout(1000);
  }
  if (!match) throw new Error("60 秒内未找到全部已收藏数量");
  return Number(match[1]);
}

async function submitBasicReport(page, count) {
  const selectAll = await uniqueVisible(page.getByText(`选择全部(${count})`, { exact: true }), "选择全部");
  await selectAll.click();
  await (await uniqueVisible(page.getByText(`全不选(${count})`, { exact: true }), "全不选状态")).waitFor({ state: "visible" });

  const downloadData = await uniqueVisible(page.getByText("下载数据", { exact: true }), "下载数据");
  await downloadData.click();

  const dialog = page.getByRole("dialog", { name: "下载信息选择" });
  await dialog.waitFor({ state: "visible" });
  const basic = dialog.getByRole("radio", { name: /基础信息下载/ });
  if (await basic.count() !== 1) throw new Error("基础信息下载选项不唯一");
  if (!(await basic.isChecked())) await basic.check();
  if (!(await basic.isChecked())) throw new Error("无法选中基础信息下载");

  const confirm = dialog.getByRole("button", { name: "确认", exact: true });
  if (await confirm.count() !== 1) throw new Error("确认按钮不唯一");
  const deadline = Date.now() + 10_000;
  while (!(await confirm.isEnabled()) && Date.now() < deadline) {
    await page.waitForTimeout(250);
  }
  if (!(await confirm.isEnabled())) throw new Error("确认按钮在 10 秒内未启用");
  await confirm.click();
}

function extractReportFilename(text) {
  return text.match(/产品信息下载_基础[^\r\n]*?\.xlsx/)?.[0] || null;
}

async function findTargetTask(page) {
  const rows = page.getByRole("row");
  const matching = rows.filter({ hasText: "产品信息下载_基础" });
  for (let index = 0; index < await matching.count(); index += 1) {
    const row = matching.nth(index);
    const text = await row.innerText();
    const filename = extractReportFilename(text);
    const applicationTime = text.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)?.[0];
    if (!filename) continue;
    return {
      row,
      filename,
      applicationTime: applicationTime || "",
    };
  }
  return null;
}

async function waitForTask(page, timeoutMinutes) {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  while (Date.now() < deadline) {
    await page.goto(DOWNLOAD_CENTER_URL, { waitUntil: "domcontentloaded" });
    const task = await findTargetTask(page);
    if (task) return task;
    console.log("[查询] 下载中心尚未找到文件名称包含 产品信息下载_基础 的报表，继续等待");
    await page.waitForTimeout(10_000);
  }
  throw new Error(`等待下载中心出现文件名称包含 产品信息下载_基础 的报表超过 ${timeoutMinutes} 分钟`);
}

function parseSizeBytes(text) {
  const match = text.match(/([0-9.]+)\s*(KB|MB|GB)/i);
  if (!match) return 0;
  const factor = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[match[2].toUpperCase()];
  return Number(match[1]) * factor;
}

async function waitUntilDownloadable(page, task, timeoutMinutes) {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  while (Date.now() < deadline) {
    await page.reload({ waitUntil: "domcontentloaded" });
    let row = page.getByRole("row").filter({ hasText: task.filename });
    if (task.applicationTime) row = row.filter({ hasText: task.applicationTime });
    const renderDeadline = Math.min(deadline, Date.now() + 30_000);
    let rowCount = await row.count();
    while (rowCount === 0 && Date.now() < renderDeadline) {
      await page.waitForTimeout(500);
      rowCount = await row.count();
    }
    if (rowCount > 1) throw new Error("存在多条同名且申请时间相同的任务行");
    if (rowCount === 0) {
      console.log("[生成] 页面尚未加载目标任务，继续刷新等待");
      continue;
    }
    const text = await row.innerText();
    const downloadable = (await row.getByText("下载", { exact: true }).count()) === 1;
    const size = parseSizeBytes(text);
    const progress = text.match(/([0-9.]+)%/)?.[1];
    console.log(`[生成] ${progress ? `${progress}%` : text.includes("已生成") ? "已生成" : "处理中"} ${size ? `${Math.round(size / 1024)}KB` : ""}`);
    if (downloadable && size > 0) return row;
    await page.waitForTimeout(10_000);
  }
  throw new Error(`等待报表生成超过 ${timeoutMinutes} 分钟`);
}

function filenameFromDisposition(value, fallback) {
  if (!value) return fallback;
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8) return decodeURIComponent(utf8);
  return value.match(/filename=\"?([^\";]+)\"?/i)?.[1] || fallback;
}

async function downloadTask(page, context, row, task, tempDir) {
  const action = row.getByText("下载", { exact: true });
  if (await action.count() !== 1) throw new Error("下载操作不唯一");

  const downloadPromise = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
  const popupPromise = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
  await action.click();
  const [download, popup] = await Promise.all([downloadPromise, popupPromise]);
  await fsp.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, task.filename);

  if (download) {
    await download.saveAs(tempPath);
    return tempPath;
  }
  if (!popup) throw new Error("点击下载后既没有下载事件，也没有打开文件标签页");
  const signedUrl = popup.url();
  if (!signedUrl.includes("b2bfiles1.gigab2b.cn/downloadJobFile/")) throw new Error("下载标签页 URL 不符合预期");
  const response = await context.request.get(signedUrl);
  if (response.status() !== 200) throw new Error(`下载请求返回 HTTP ${response.status()}`);
  const body = await response.body();
  const actualName = filenameFromDisposition(response.headers()["content-disposition"], task.filename);
  const actualPath = path.join(tempDir, actualName);
  await fsp.writeFile(actualPath, body);
  await popup.close().catch(() => {});
  return actualPath;
}

async function archiveReport(source, destinationDir) {
  const size = await validateXlsx(source);
  await fsp.mkdir(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, path.basename(source));
  await fsp.copyFile(source, destination);
  const copiedSize = await validateXlsx(destination);
  if (copiedSize !== size) throw new Error("归档后的文件大小不一致");
  return { path: destination, size: copiedSize, xlsx_valid: true, sha256: await sha256(destination) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const config = await loadConfig(options.configPath);
  const targetDates = dateParts(config.targetDate);
  const downloadRoot = options.baseDir || config.downloadRoot;
  const destinationDir = path.join(downloadRoot, targetDates.dashed);
  const existing = await findExistingValidReport(destinationDir);
  if (existing && !options.force) {
    console.log(JSON.stringify({ skipped: true, reason: "target_date_report_exists", target_date: config.targetDate, path: existing }, null, 2));
    return;
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP(options.cdpUrl);
  } catch {
    throw new Error(`无法连接普通 Chrome (${options.cdpUrl})。请先运行 open-giga-login-de.ps1 并保持窗口打开。`);
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error("普通 Chrome 没有可接管的浏览器上下文");
  let page = context.pages().find((candidate) => candidate.url().includes("gigab2b.com")) || context.pages()[0] || await context.newPage();
  try {
    console.log("[1/5] 检查登录状态");
    await ensureLoggedIn(page);
    if (options.resumeFilename) {
      const task = { filename: options.resumeFilename, applicationTime: options.resumeTime };
      console.log(`[恢复] ${task.filename} / ${task.applicationTime}`);
      await page.goto(DOWNLOAD_CENTER_URL, { waitUntil: "domcontentloaded" });
      const row = await waitUntilDownloadable(page, task, options.timeoutMinutes);
      console.log("[4/5] 下载并验证 XLSX");
      const tempDir = path.join(path.dirname(config.path), "work", "downloads");
      const downloaded = await downloadTask(page, context, row, task, tempDir);
      console.log("[5/5] 归档报表");
      const result = await archiveReport(downloaded, destinationDir);
      console.log(JSON.stringify({ ...result, archive_date: config.targetDate }, null, 2));
      return;
    }
    if (options.dryRun) {
      const count = await getWishlistCount(page);
      console.log(JSON.stringify({
        dry_run: true,
        logged_in: true,
        wishlist_count: count,
        target_date: config.targetDate,
        destination_dir: destinationDir,
      }, null, 2));
      return;
    }

    let task;
    if (config.targetDate === config.today) {
      const count = await getWishlistCount(page);
      console.log(`[2/5] 已登录，全部已收藏 ${count} 个产品`);
      console.log("[3/5] 提交基础信息下载任务");
      await submitBasicReport(page, count);
      await page.goto(DOWNLOAD_CENTER_URL, { waitUntil: "domcontentloaded" });
      task = await waitForTask(page, options.timeoutMinutes);
    } else {
      console.log("[2/5] 已登录，查询下载中心最近的基础信息报表");
      task = await waitForTask(page, options.timeoutMinutes);
    }
    console.log(`[任务] ${task.filename} / ${task.applicationTime}`);
    const row = await waitUntilDownloadable(page, task, options.timeoutMinutes);

    console.log("[4/5] 下载并验证 XLSX");
    const tempDir = path.join(path.dirname(config.path), "work", "downloads");
    const downloaded = await downloadTask(page, context, row, task, tempDir);
    console.log("[5/5] 归档报表");
    const result = await archiveReport(downloaded, destinationDir);
    console.log(JSON.stringify({ ...result, archive_date: config.targetDate }, null, 2));
  } finally {
    // Exiting this CDP client disconnects it; browser.close() would terminate the user's Chrome.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(JSON.stringify({ error: error.message, stack: process.env.DEBUG ? error.stack : undefined }, null, 2));
      process.exit(1);
    });
}
