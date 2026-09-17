#!/usr/bin/env node

import process from "node:process";
import { createRequire } from "node:module";
import { loadConfig } from "./giga-config.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
import { solveSliderCaptcha } from "./giga-captcha.mjs";

function parseArgs(argv) {
  const options = {
    configPath: "giga-report.json",
    cdpUrl: "http://127.0.0.1:9224",
    timeoutMs: 600_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config-path") options.configPath = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (!arg.startsWith("-")) options.cdpUrl = arg;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms 必须是正数");
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log("用法: node giga-login.mjs [--config-path <path>] [--timeout-ms <ms>] [cdp-url]");
  process.exit(0);
}
const config = await loadConfig(options.configPath);
const { username, password } = config;

const LOGIN_URL = "https://gigab2b.com/index.php?route=account/login";
const WISHLIST_URL = "https://www.gigab2b.com/index.php?route=account/wishlist";
const SAFE_CAPTCHA_URL_PART = "route=safe/captcha";

const browser = await chromium.connectOverCDP(options.cdpUrl);
const context = browser.contexts()[0];
if (!context) throw new Error("Chrome 没有可接管的浏览器上下文");
const gigaPages = context.pages().filter((candidate) => candidate.url().includes("gigab2b.com"));
const page = gigaPages.at(-1) || context.pages()[0] || await context.newPage();
if (!page.url() || page.url() === "about:blank") {
  await page.goto(WISHLIST_URL, { waitUntil: "domcontentloaded" });
}
console.log(`[登录] 当前页面: ${page.url() || "about:blank"}`);
for (const duplicate of gigaPages) {
  if (duplicate !== page) await duplicate.close().catch(() => {});
}

const openWishlistAndCheck = async () => {
  await page.goto(WISHLIST_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  if (page.url().includes(SAFE_CAPTCHA_URL_PART)) return false;
  const passwordVisible = await page.locator('input[type="password"],input[placeholder="Password" i]')
    .first().isVisible().catch(() => false);
  return !page.url().includes("route=account/login") && !passwordVisible;
};

const captcha = page.locator("#aliyunCaptcha-window-popup");
const safeCaptchaPage = () => page.url().includes(SAFE_CAPTCHA_URL_PART);
const safeVerifyButton = () => page.getByRole("button", { name: "Verify", exact: true });

async function visibleLocator(selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const candidates = await locator.all();
    for (const candidate of candidates) {
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function isLoginFormVisible() {
  return Boolean(await visibleLocator([
    'input[placeholder="Password" i]',
    'input[type="password"]',
  ]));
}

async function activateSafeCaptcha() {
  if (!safeCaptchaPage()) return false;
  if (await captcha.isVisible().catch(() => false)) return true;
  const verify = safeVerifyButton();
  if (await verify.count() === 1 && await verify.isVisible().catch(() => false)) {
    console.log("[登录] 检测到 Safe Checker 验证页，点击 Verify 进入滑块验证。");
    await verify.click();
  } else {
    const textVerify = page.getByText("Verify", { exact: true });
    if (await textVerify.count() === 1 && await textVerify.isVisible().catch(() => false)) {
      console.log("[登录] 检测到 Safe Checker 验证页，点击 Verify 进入滑块验证。");
      await textVerify.click();
    } else {
      return false;
    }
  }
  try {
    await captcha.waitFor({ state: "visible", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

async function solveVisibleCaptcha() {
  if (!(await captcha.isVisible().catch(() => false))) return true;
  console.log("[登录] 检测到滑块验证码，尝试自动完成。");
  const solved = await solveSliderCaptcha(page, { maxAttempts: 8, log: console.log });
  if (solved) {
    console.log("[登录] 滑块验证码已自动完成。");
  } else {
    console.log("[登录] 自动完成验证码未成功，请手动拖动滑块；脚本会继续等待登录完成。");
  }
  return solved;
}

const captchaAlreadyVisible = await captcha.isVisible().catch(() => false);
const loginFormAlreadyVisible = await isLoginFormVisible();
let safeCaptchaAlreadyVisible = safeCaptchaPage();

if (!captchaAlreadyVisible && !loginFormAlreadyVisible) {
  if (await openWishlistAndCheck()) {
    console.log("[登录] 已有有效登录会话，无需重新填写。");
    process.exit(0);
  }
  safeCaptchaAlreadyVisible = safeCaptchaPage();
}

if (safeCaptchaAlreadyVisible) {
  console.log("[登录] 当前页面是 Safe Checker 验证页。");
  await activateSafeCaptcha();
  await solveVisibleCaptcha();
  if (await openWishlistAndCheck()) {
    console.log("[登录] 验证通过，已有有效登录会话，无需重新填写。");
    process.exit(0);
  }
  safeCaptchaAlreadyVisible = safeCaptchaPage();
}

// A restored or redirected login page can show inputs before its reactive state is ready.
// Reload a clean login route before filling, unless a live CAPTCHA must be preserved.
if (!captchaAlreadyVisible && !safeCaptchaAlreadyVisible) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
}
console.log(`[登录] 页面状态: ${page.url()}`);
const acceptCookies = page.getByText("Accept", { exact: true });
if (await acceptCookies.count() === 1 && await acceptCookies.isVisible()) {
  await acceptCookies.click();
}
const emailSelectors = [
  'input[placeholder="Email" i]',
  'input[type="email"]',
  'input[name="email"]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
  'input[type="text"]',
];
const passwordSelectors = [
  'input[placeholder="Password" i]',
  'input[type="password"]',
];
const email = await visibleLocator(emailSelectors);
const passwordInput = await visibleLocator(passwordSelectors);
if (!captchaAlreadyVisible && !safeCaptchaAlreadyVisible) {
  if (!email || !passwordInput) {
    throw new Error(`登录页面未找到可见的账号或密码输入框: ${page.url()}`);
  }
  await email.fill("");
  await email.click();
  await email.pressSequentially(username, { delay: 25 });
  await passwordInput.fill("");
  await passwordInput.click();
  await passwordInput.pressSequentially(password, { delay: 25 });
  if ((await email.inputValue()).length === 0 || (await passwordInput.inputValue()).length === 0) {
    throw new Error("账号密码未成功写入登录表单");
  }

  const loginButton = page.getByText("Login Now", { exact: true });
  if (await loginButton.count() !== 1) {
    throw new Error("Login Now 控件不唯一");
  }
  await loginButton.waitFor({ state: "visible", timeout: 10_000 });
  console.log("[登录] 已自动填写账号密码并点击 Login Now。");
  const loginResponsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes("gigab2b.com/index.php"),
    { timeout: 20_000 },
  ).catch(() => null);
  await loginButton.click();
  const loginResponse = await loginResponsePromise;
  if (!loginResponse) {
    throw new Error("点击 Login Now 后 20 秒内未发出登录请求");
  }
  let loginResult = null;
  try {
    loginResult = await loginResponse.json();
  } catch {}
  if (loginResult?.code !== 100010 && loginResult?.error) {
    throw new Error(`登录接口返回错误: ${loginResult.error}`);
  }
  if (loginResult?.code === 100010) {
    console.log("[登录] 网站要求进行滑块验证。");
  }
  const captchaDeadline = Date.now() + 20_000;
  while (Date.now() < captchaDeadline && !(await captcha.isVisible().catch(() => false))) {
    if (await activateSafeCaptcha()) break;
    await page.waitForTimeout(250);
  }
  if (page.url().includes("route=account/login") && await passwordInput.isVisible().catch(() => false)) {
    const captchaVisible = await captcha.isVisible().catch(() => false);
    if (!captchaVisible) {
      throw new Error("点击登录后 20 秒内未显示验证码，且仍停留在登录表单");
    }
  }
}
if (safeCaptchaPage()) await activateSafeCaptcha();
await solveVisibleCaptcha();

const deadline = Date.now() + options.timeoutMs;
while (Date.now() < deadline) {
  if (safeCaptchaPage()) {
    await activateSafeCaptcha();
  }
  await solveVisibleCaptcha();
  const passwordVisible = await isLoginFormVisible();
  if (!page.url().includes("route=account/login") && !passwordVisible) {
    if (await openWishlistAndCheck()) {
      console.log("[登录] 检测到登录成功。");
      process.exit(0);
    }
  }
  await page.waitForTimeout(1000);
}
throw new Error("等待人工验证码和登录超过规定时间");
