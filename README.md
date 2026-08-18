# GIGA 基础产品报表便携版

## 新电脑首次安装

1. 安装 Google Chrome 和 Node.js LTS。
2. 复制整个 `giga-report-cli` 目录到新电脑。
3. 在该目录打开 PowerShell，执行一次：

```powershell
.\install-dependencies.ps1
```

也可以直接执行：

```powershell
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
npm install
```

安装完成后，所有依赖位于当前目录的 `node_modules`，脚本不再依赖 Codex
运行时或固定的 Windows 用户名。

## 美国站

用户环境变量：`giga_username`、`giga_pwd`。

```powershell
.\run-giga-report.ps1
```

默认保存到：

```text
E:\Dux(德国)库存调整\yyyy-MM-dd
```

## 德国站

用户环境变量：`giga_usernamede`、`giga_pwdde`。

```powershell
.\run-giga-report-de.ps1
```

使用 `Europe/Berlin` 日期，默认保存到：

```text
E:\Dux(德国)在售库存报表下载\yyyy-MM-dd
```

## 测试和强制下载

```powershell
# 只验证登录、收藏数量和保存路径，不提交报表
.\run-giga-report.ps1 --dry-run
.\run-giga-report-de.ps1 --dry-run

# 当天已有报表时仍强制重新下载
.\run-giga-report.ps1 --force
.\run-giga-report-de.ps1 --force
```

首次登录或登录状态失效时，Chrome 会打开并自动填写账号密码。若网站弹出阿里云
滑块验证码，脚本会通过 `giga-captcha.mjs` 自动识别缺口位置并尝试拖动完成（最多
重试若干次）。阿里云的飞翎（FeiLin）行为风控会检测拖动轨迹，自动通过率并非
100%；若多次自动验证失败，脚本会打印提示并继续等待人工拖动完成登录。

美国站和德国站使用不同的 Chrome profile 和调试端口，互不影响。
