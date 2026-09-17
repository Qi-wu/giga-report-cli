import fsp from "node:fs/promises";
import path from "node:path";

export const DEFAULT_CONFIG_FILENAME = "giga-report.json";
export const DEFAULT_DOWNLOAD_ROOT = String.raw`E:\Dux(德国)在售库存报表下载`;

function localDateParts(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return {
    dashed: `${year}-${month}-${day}`,
    compact: `${year}${month}${day}`,
  };
}

function isRealDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}

export function resolveConfigPath(configPath) {
  return path.resolve(configPath || DEFAULT_CONFIG_FILENAME);
}

export async function loadConfig(configPath) {
  const resolvedPath = resolveConfigPath(configPath);
  let raw;
  try {
    raw = await fsp.readFile(resolvedPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`配置文件不存在: ${resolvedPath}`);
    }
    throw new Error(`读取配置文件失败: ${resolvedPath} (${error.message})`);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(`配置文件不是有效 JSON: ${resolvedPath} (${error.message})`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("配置文件根节点必须是 JSON 对象");
  }

  if (typeof config.username !== "string" || config.username.trim() === "") {
    throw new Error("配置项 username 必须是非空字符串");
  }
  if (typeof config.password !== "string" || config.password === "") {
    throw new Error("配置项 password 必须是非空字符串");
  }
  if (config.downloadRoot !== undefined
    && (typeof config.downloadRoot !== "string" || config.downloadRoot.trim() === "")) {
    throw new Error("配置项 downloadRoot 必须是非空字符串");
  }
  if (!config.feishu || typeof config.feishu !== "object" || Array.isArray(config.feishu)) {
    throw new Error("配置项 feishu 必须是对象，并包含 appId、appSecret、openId");
  }
  if (typeof config.feishu.appId !== "string" || config.feishu.appId.trim() === "") {
    throw new Error("配置项 feishu.appId 必须是非空字符串");
  }
  if (typeof config.feishu.appSecret !== "string" || config.feishu.appSecret.trim() === "") {
    throw new Error("配置项 feishu.appSecret 必须是非空字符串");
  }
  if (typeof config.feishu.openId !== "string" || config.feishu.openId.trim() === "") {
    throw new Error("配置项 feishu.openId 必须是非空字符串");
  }

  const targetDateValue = config.targetDate;
  let targetDate;
  if (targetDateValue === undefined || targetDateValue === null || targetDateValue === "") {
    targetDate = localDateParts().dashed;
  } else {
    if (typeof targetDateValue !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(targetDateValue)) {
      throw new Error("配置项 targetDate 必须使用 yyyy-MM-dd 格式");
    }
    if (!isRealDate(targetDateValue)) {
      throw new Error(`配置项 targetDate 不是有效日期: ${targetDateValue}`);
    }
    targetDate = targetDateValue;
  }

  const today = localDateParts().dashed;
  if (targetDate > today) {
    throw new Error(`配置项 targetDate 不能晚于系统日期 ${today}: ${targetDate}`);
  }

  return {
    path: resolvedPath,
    username: config.username,
    password: config.password,
    downloadRoot: config.downloadRoot?.trim() || DEFAULT_DOWNLOAD_ROOT,
    feishu: {
      appId: config.feishu.appId.trim(),
      appSecret: config.feishu.appSecret.trim(),
      openId: config.feishu.openId.trim(),
    },
    targetDate,
    today,
  };
}

export function dateParts(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`日期格式无效: ${date}`);
  }
  return {
    dashed: date,
    compact: date.replaceAll("-", ""),
  };
}
