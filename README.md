# GIGA 基础产品报表下载

## 首次安装

1. 安装 Google Chrome 和 Node.js LTS。
2. 复制整个 `giga-report-cli` 目录到部署目录。
3. 在该目录打开 PowerShell，执行一次：

```powershell
.\install-dependencies.ps1
```

4. 复制 `giga-report.example.json` 为 `giga-report.json`，填写账号密码。

实际配置文件只保存在本机，不要提交到版本库。脚本会自动使用配置文件所在目录下的
`work` 目录保存 Chrome profile 和临时下载文件。

## 配置文件

`giga-report.json`：

```json
{
  "username": "your-giga-username",
  "password": "your-giga-password",
  "downloadRoot": "E:\\Dux(德国)在售库存报表下载",
  "feishu": {
    "appId": "cli_xxxxxxxxxxxxxxxxx",
    "appSecret": "your-feishu-app-secret",
    "openId": "ou_xxxxxxxxxxxxxxxxx"
  },
  "targetDate": null
}
```

- `username` 和 `password` 必填。
- `downloadRoot` 指定文件保存根路径，缺省时使用
  `E:\Dux(德国)在售库存报表下载`。
- `feishu.appId`：飞书自建应用的 App ID。
- `feishu.appSecret`：飞书自建应用的 App Secret。
- `feishu.openId`：接收通知用户的 Open ID。
- `targetDate` 使用 `yyyy-MM-dd` 格式。
- `targetDate` 缺省、为 `null` 或为空字符串时，使用运行机器的系统本地日期。
- 目标日期不能晚于系统日期。
- 密码为明文配置，请限制 `giga-report.json` 的文件访问权限。

## 定时运行

执行入口只有：

```powershell
.\giga-report.ps1
```

脚本使用德国站专用 Chrome profile 和 CDP 端口 `9224`。首次登录或登录状态失效时，
脚本会打开 Chrome 并自动填写配置文件中的账号密码。若网站弹出阿里云滑块验证码，
脚本会尝试自动完成；失败时会等待人工完成验证。

每天使用不同账号时，复制出多个独立部署目录，每个目录配置自己的
`giga-report.json`，并为每个目录创建一个不同启动时间的定时任务。每个目录拥有独立
的 Chrome profile、CDP 会话和临时下载目录，不会读取系统环境变量中的账号或密码。

飞书应用需要开启机器人能力，并确保目标用户在应用可用范围内。报表流程成功或失败后，
脚本会通过飞书向 `openId` 指定的用户发送文本通知。飞书通知发送失败只记录警告，
不会覆盖报表任务本身的成功或失败结果。

飞书通知正文由 Node.js 以 UTF-8 直接生成，不经过 Windows PowerShell 的本地代码页，
因此在中文、英文或德文 Windows 系统上运行时，账号、中文标题和保存路径都不会乱码。

## 报表流程

当 `targetDate` 等于系统日期时：

1. 登录 GIGA。
2. 在收藏夹提交基础信息下载任务。
3. 打开“下载中心”。
4. 按下载中心表格从上到下查找，选择最近一条文件名包含 `产品信息下载_基础` 的报表。
5. 等待生成、下载并验证 XLSX。

当 `targetDate` 是历史日期时，脚本只查询“下载中心”中已经存在的报表，不会重新申请任务。
找不到目标文件名时会持续刷新等待，超过超时时间后以非零退出码结束。

文件默认保存到（`downloadRoot` 拼接目标日期）：

```text
E:\Dux(德国)在售库存报表下载\yyyy-MM-dd
```

归档目录使用配置中的目标日期，不使用执行日期，也不计算不同站点之间的时差。
下载中心查询不再判断文件名是否包含当前日期或目标日期，只按表格从上到下选择最近一条
文件名包含 `产品信息下载_基础` 的报表。报表仍保存到配置目标日期对应的目录。

## 运维参数

```powershell
# 只验证登录、收藏数量和保存路径，不提交报表
.\giga-report.ps1 --dry-run

# 目标日期目录已有有效报表时仍强制重新下载
.\giga-report.ps1 --force

# 调整等待报表生成的最长时间
.\giga-report.ps1 --timeout-minutes 30

# 使用已有任务信息继续下载
.\giga-report.ps1 `
  --resume-filename '产品信息下载_基础 20260831.xlsx' `
  --resume-time '2026-08-31 10:30:00'
```

也可以覆盖归档根目录或 CDP 地址：

```powershell
.\giga-report.ps1 --base-dir 'D:\GIGA\reports' --cdp-url 'http://127.0.0.1:9224'
```
