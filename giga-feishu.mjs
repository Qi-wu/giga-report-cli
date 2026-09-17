#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./giga-config.mjs";

const FEISHU_API_BASE = "https://open.feishu.cn";

function parseArgs(argv) {
  const options = {
    configPath: "giga-report.json",
    status: null,
    message: "",
    error: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config-path") options.configPath = argv[++index];
    else if (arg === "--status") options.status = argv[++index];
    else if (arg === "--message") options.message = argv[++index];
    else if (arg === "--error") options.error = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (options.help) return options;
  if (options.status !== "success" && options.status !== "failure") {
    throw new Error("--status 必须是 success 或 failure");
  }
  return options;
}

function buildNotificationText(config, options) {
  if (options.message.trim()) return options.message.trim();
  if (options.status === "success") {
    return [
      "GIGA报表下载成功",
      `账号: ${config.username}`,
      `目标日期: ${config.targetDate}`,
      `保存根路径: ${config.downloadRoot}`,
    ].join("\n");
  }
  return [
    "GIGA报表下载失败",
    `账号: ${config.username}`,
    `目标日期: ${config.targetDate}`,
    `错误: ${options.error.trim() || "未提供错误详情"}`,
  ].join("\n");
}

async function parseResponse(response, description) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${description}返回了无法解析的响应 (HTTP ${response.status})`);
  }
  if (!response.ok || body.code !== 0) {
    const detail = body.msg || body.message || `HTTP ${response.status}`;
    const code = body.code === undefined ? "" : ` (code ${body.code})`;
    throw new Error(`${description}失败: ${detail}${code}`);
  }
  return body;
}

export async function sendFeishuText(config, text) {
  const tokenResponse = await fetch(
    `${FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: config.feishu.appId,
        app_secret: config.feishu.appSecret,
      }),
    },
  );
  const tokenBody = await parseResponse(tokenResponse, "飞书 tenant_access_token 获取");
  if (!tokenBody.tenant_access_token) {
    throw new Error("飞书 tenant_access_token 获取成功但响应中缺少 token");
  }

  const messageResponse = await fetch(
    `${FEISHU_API_BASE}/open-apis/im/v1/messages?receive_id_type=open_id`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenBody.tenant_access_token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: config.feishu.openId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    },
  );
  await parseResponse(messageResponse, "飞书消息发送");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("用法: node giga-feishu.mjs --config-path <path> --status <success|failure> [--error <text>] [--message <text>]");
    return;
  }
  const config = await loadConfig(options.configPath);
  await sendFeishuText(config, buildNotificationText(config, options));
  console.log(`[飞书] ${options.status === "success" ? "成功" : "失败"}通知已发送`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      console.error(JSON.stringify({ error: error.message }, null, 2));
      process.exit(1);
    });
}
