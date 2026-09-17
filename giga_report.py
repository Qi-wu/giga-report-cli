#!/usr/bin/env python3
"""Orchestrate normal-Chrome login handoff and Playwright report download."""

from __future__ import annotations

import argparse
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
WORK_DIR = ROOT / "work"
PROFILE_DIR = WORK_DIR / "giga-de-cdp-profile"
CONFIG_PATH = ROOT / "giga-report.json"
GIGA_URL = "https://www.gigab2b.com/index.php?route=account/wishlist"
CDP_PORT = 9224
CDP_URL = f"http://127.0.0.1:{CDP_PORT}"
INSTANCE_LOCK_PORT = 9225
RUNTIME = Path(r"C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies")
NODE = RUNTIME / "node" / "bin" / "node.exe"
NODE_MODULES = RUNTIME / "node" / "node_modules"
PLAYWRIGHT_SCRIPT = ROOT / "giga-us-basic-report.mjs"
LOGIN_SCRIPT = ROOT / "giga-login.mjs"
NOTIFY_SCRIPT = ROOT / "giga-feishu.mjs"


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
    env = os.environ.copy()
    env["NODE_PATH"] = str(NODE_MODULES)
    result = subprocess.run(
        [
            str(NODE),
            str(LOGIN_SCRIPT),
            "--config-path",
            str(CONFIG_PATH),
            "--timeout-ms",
            str(timeout_minutes * 60_000),
            CDP_URL,
        ],
        env=env,
        check=False,
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
    command = [
        str(NODE),
        str(PLAYWRIGHT_SCRIPT),
        "--config-path",
        str(CONFIG_PATH),
        "--cdp-url",
        CDP_URL,
        *extra_args,
    ]
    return subprocess.run(command, env=env, check=False).returncode


def send_notification(status: str, error_message: str = "") -> None:
    env = os.environ.copy()
    env["NODE_PATH"] = str(NODE_MODULES)
    try:
        command = [
            str(NODE),
            str(NOTIFY_SCRIPT),
            "--config-path",
            str(CONFIG_PATH),
            "--status",
            status,
        ]
        if error_message:
            command.extend(["--error", error_message])
        result = subprocess.run(
            command,
            env=env,
            check=False,
        )
        if result.returncode != 0:
            print("飞书通知发送失败。", file=sys.stderr)
    except OSError as exc:
        print(f"飞书通知发送失败: {exc}", file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="下载 GIGA 美国基础产品报表")
    parser.add_argument("--login-timeout-minutes", type=int, default=10)
    parser.add_argument("playwright_args", nargs=argparse.REMAINDER)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    instance_lock = acquire_instance_lock()
    chrome = find_chrome()
    success = False
    failure_message = ""
    try:
        cdp_process = launch_cdp_chrome(chrome)
        try:
            run_login(args.login_timeout_minutes)
            result = run_playwright(args.playwright_args)
            if result != 0:
                raise RuntimeError(f"GIGA report failed with exit code {result}")
            success = True
            return result
        except Exception as exc:
            failure_message = str(exc)
            raise
        finally:
            status = "success" if success else "failure"
            send_notification(status, failure_message)
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
