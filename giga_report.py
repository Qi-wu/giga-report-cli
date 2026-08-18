#!/usr/bin/env python3
"""Orchestrate normal-Chrome login handoff and Playwright report download."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WORK_DIR = ROOT.parent / "work"
PROFILE_DIR = WORK_DIR / "giga-cdp-profile"
GIGA_URL = "https://www.gigab2b.com/index.php?route=account/wishlist"
CDP_PORT = 9223
CDP_URL = f"http://127.0.0.1:{CDP_PORT}"
INSTANCE_LOCK_PORT = 9222
RUNTIME = Path(r"C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies")
NODE = RUNTIME / "node" / "bin" / "node.exe"
NODE_MODULES = RUNTIME / "node" / "node_modules"
PLAYWRIGHT_SCRIPT = ROOT / "giga-us-basic-report.mjs"
LOGIN_SCRIPT = ROOT / "giga-login.mjs"


def user_environment(name: str) -> str | None:
    value = os.environ.get(name)
    if value:
        return value
    if os.name != "nt":
        return None
    buffer_size = 32767
    buffer = ctypes.create_unicode_buffer(buffer_size)
    length = ctypes.windll.kernel32.GetEnvironmentVariableW(name, buffer, buffer_size)
    return buffer.value if length else None


def find_chrome() -> Path:
    candidates = [
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise RuntimeError("找不到 Google Chrome")


def acquire_instance_lock() -> socket.socket:
    lock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if os.name == "nt":
        lock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        lock.bind(("127.0.0.1", INSTANCE_LOCK_PORT))
        lock.listen(1)
    except OSError as exc:
        lock.close()
        raise RuntimeError(
            "已有 GIGA 报表任务正在运行。请完成或关闭原任务后再试。"
        ) from exc
    return lock


def terminate_process_tree(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()


def wait_for_cdp(timeout: float = 20) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{CDP_URL}/json/version", timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.25)
    raise RuntimeError("Chrome CDP 调试端口未在规定时间内启动")


def run_login(timeout_minutes: int) -> None:
    username = user_environment("giga_username")
    password = user_environment("giga_pwd")
    if not username or not password:
        raise RuntimeError("缺少系统环境变量 giga_username 或 giga_pwd")

    env = os.environ.copy()
    env["NODE_PATH"] = str(NODE_MODULES)
    env["giga_username"] = username
    env["giga_pwd"] = password
    env["GIGA_LOGIN_TIMEOUT_MS"] = str(timeout_minutes * 60_000)
    result = subprocess.run(
        [str(NODE), str(LOGIN_SCRIPT), CDP_URL], env=env, check=False
    )
    if result.returncode != 0:
        raise RuntimeError("自动填写或登录未完成，请查看上方错误")


def launch_cdp_chrome(chrome: Path) -> subprocess.Popen[bytes]:
    process = subprocess.Popen([
        str(chrome),
        f"--remote-debugging-port={CDP_PORT}",
        f"--user-data-dir={PROFILE_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
    ])
    wait_for_cdp()
    return process


def run_playwright(extra_args: list[str]) -> int:
    if not NODE.is_file():
        raise RuntimeError(f"找不到 Codex Node.js: {NODE}")
    env = os.environ.copy()
    env["NODE_PATH"] = str(NODE_MODULES)
    if extra_args[:1] == ["--"]:
        extra_args = extra_args[1:]
    command = [str(NODE), str(PLAYWRIGHT_SCRIPT), "--cdp-url", CDP_URL, *extra_args]
    return subprocess.run(command, env=env, check=False).returncode


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="下载 GIGA 美国基础产品报表")
    parser.add_argument("--login-timeout-minutes", type=int, default=10)
    parser.add_argument("playwright_args", nargs=argparse.REMAINDER)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    instance_lock = acquire_instance_lock()
    chrome = find_chrome()
    try:
        cdp_process = launch_cdp_chrome(chrome)
        try:
            run_login(args.login_timeout_minutes)
            return run_playwright(args.playwright_args)
        finally:
            terminate_process_tree(cdp_process)
    finally:
        instance_lock.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n已取消。", file=sys.stderr)
        raise SystemExit(130)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
