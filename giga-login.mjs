#!/usr/bin/env node

import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
import { solveSliderCaptcha } from "./giga-captcha.mjs";

const CDP_URL = process.argv[2] || "http://127.0.0.1:9223";
const LOGIN_URL = "https://gigab2b.com/index.php?route=account/login";
const WISHLIST_URL = "https://gigab2b.com/index.php?route=account/wishlist";
const username = process.env.giga_username;
const password = process.env.giga_pwd;

if (!username || !password) {
  throw new Error("缺少环境变量 giga_username 或 giga_pwd");
}

const browser = await chromium.connectOverCDP(CDP_URL);
const context = browser.contexts()[0];
if (!context) throw new Error("Chrome 没有可接管的浏览器上下文");
const gigaPages = context.pages().filter((candidate) => candidate.url().includes("gigab2b.com"));
const page = gigaPages.at(-1) || context.pages()[0] || await context.newPage();
for (const duplicate of gigaPages) {
  if (duplicate !== page) await duplicate.close().catch(() => {});
}

const openWishlistAndCheck = async () => {
  await page.goto(WISHLIST_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const passwordVisible = await page.locator('input[type="password"],input[placeholder="Password" i]')
    .first().isVisible().catch(() => false);
  return !page.url().includes("route=account/login") && !passwordVisible;
};

const captcha = page.locator("#aliyunCaptcha-window-popup");
const captchaAlreadyVisible = await captcha.isVisible().catch(() => false);
const loginFormAlreadyVisible = await page.locator('input[type="password"],input[placeholder="Password" i]')
  .first().isVisible().catch(() => false);

if (!captchaAlreadyVisible && !loginFormAlreadyVisible) {
  if (await openWishlistAndCheck()) {
    console.log("[登录] 已有有效登录会话，无需重新填写。");
    process.exit(0);
  }
}

// A restored or redirected login page can show inputs before its reactive state is ready.
// Reload a clean login route before filling, unless a live CAPTCHA must be preserved.
if (!captchaAlreadyVisible) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
}
const acceptCookies = page.getByText("Accept", { exact: true });
if (await acceptCookies.count() === 1 && await acceptCookies.isVisible()) {
  await acceptCookies.click();
}
const email = page.locator([
  'input[placeholder="Email" i]',
  'input[type="email"]',
  'input[name="email"]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
  'input[type="text"]',
].join(",")).first();
const passwordInput = page.locator('input[placeholder="Password" i],input[type="password"]').first();
if (!captchaAlreadyVisible) {
  await email.waitFor({ state: "visible", timeout: 30_000 });
  await passwordInput.waitFor({ state: "visible", timeout: 30_000 });
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
  try {
    await captcha.waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    const passwordStillVisible = await passwordInput.isVisible().catch(() => false);
    if (page.url().includes("route=account/login") && passwordStillVisible) {
      throw new Error("点击登录后 20 秒内未显示验证码，且仍停留在登录表单");
    }
  }
}
if (await captcha.isVisible().catch(() => false)) {
  console.log("[登录] 检测到滑块验证码，尝试自动完成。");
  const solved = await solveSliderCaptcha(page, { maxAttempts: 8, log: console.log });
  if (solved) {
    console.log("[登录] 滑块验证码已自动完成。");
  } else {
    console.log("[登录] 自动完成验证码未成功，请手动拖动滑块；脚本会继续等待登录完成。");
  }
}

const deadline = Date.now() + Number(process.env.GIGA_LOGIN_TIMEOUT_MS || 600_000);
while (Date.now() < deadline) {
  const passwordVisible = await page.locator('input[type="password"],input[placeholder="Password" i]')
    .first().isVisible().catch(() => false);
  if (!page.url().includes("route=account/login") && !passwordVisible) {
    if (await openWishlistAndCheck()) {
      console.log("[登录] 检测到登录成功。");
      process.exit(0);
    }
  }
  await page.waitForTimeout(1000);
}
throw new Error("等待人工验证码和登录超过规定时间");
