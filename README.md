# ip-tz-sync

根据**出口 IP 的地理位置**自动同步系统时区（秒级）。

Auto-sync your system timezone to your outbound IP's geolocation — in seconds.

[English](#english) | [中文](#中文)

---

## 中文

### 为什么需要它（Claude 场景）

Claude（Anthropic）对账号区域有严格的风控：除了检测 IP 属地，还会校验**系统时区等浏览器/系统指纹与 IP 地理位置是否一致**。使用 VPN 切换节点后，如果系统时区仍停留在国内（如 `Asia/Shanghai`），IP 与时区不匹配会成为明显的风控信号，增加封号风险。

`ip-tz-sync` 让系统时区**秒级跟随** VPN 出口 IP 的位置：切到美国节点，系统时区自动变为 `America/New_York`；切到日本节点，自动变为 `Asia/Tokyo`。指纹一致性由工具兜底，无需手动设置。

> 同样适用于其他校验 IP/时区一致性的服务（Google、Netflix 等）。

### 特点

- 零依赖纯 JavaScript，单文件 CLI（Node.js ≥ 18），整个包约 11 KB
- **以 Claude 视角测出口 IP**：首选请求 `claude.ai/cdn-cgi/trace`，测出的正是 Claude 服务器看到的 IP，与浏览器访问 Claude 走完全相同的路由规则
- **自动识别系统代理**：支持 Clash/V2Ray 等规则分流（浏览器代理插件、系统代理开关关闭也能用），也可用 `--proxy` 显式指定或 `--no-proxy` 强制直连
- 跨平台：Windows（`tzutil`）/ macOS（`systemsetup`）/ Linux（`timedatectl`，无 systemd 时回退 `/etc/localtime`）
- 跨 CPU 架构：x64 / arm64 / arm / ppc64le —— 凡是 Node.js 能跑的架构都能用，无原生模块
- 3 个地理位置 API 自动故障转移（ipwho.is → ipapi.co → ip-api.com）
- Windows 时区映射基于 Unicode CLDR 官方数据（446 个 IANA 时区），并按 IP 所在国家码做精细化匹配
- 可选桌面水印（**默认关闭**，`--watermark` 开启）：Windows 原生 WPF 悬浮窗，零额外依赖

### 桌面水印（可选，默认关闭）

系统时区被改成代理出口时区后，任务栏时钟显示的已是"假时间"。水印在桌面右下角常驻一块半透明悬浮窗（置顶、鼠标穿透、不占任务栏），让你始终看到真实时间：

```
2026-10-19  21:05:33                    ← 实际地区的真实时间
实际 Asia/Shanghai (UTC+08:00)          ← 直连探测的物理位置
系统 America/Los_Angeles (UTC-07:00)    ← 网站指纹看到的时区
```

```bash
ip-tz-sync --watermark        # 开启（直连探测一次实际地区并缓存，之后与系统时区无关）
ip-tz-sync --watermark-stop   # 关闭
```

主行时间由 UTC 换算到实际地区时区，系统时区怎么改都不影响它。目前仅支持 Windows。

### 安装

```bash
npm i -g ip-tz-sync     # 全局安装
npx ip-tz-sync          # 或免安装直接跑
```

### 使用

```bash
ip-tz-sync              # 检测出口 IP 并设置系统时区
ip-tz-sync -p           # 只打印检测结果（出口 IP / 位置 / 时区）
ip-tz-sync -n           # 演练模式，不实际修改
ip-tz-sync -w 2         # watch 模式：每 2 秒探测出口 IP，VPN 切节点时秒级自动切换
ip-tz-sync --tz Asia/Tokyo   # 跳过检测，直接设置指定时区
ip-tz-sync --proxy http://127.0.0.1:7897   # 显式指定本地代理端口
ip-tz-sync --no-proxy        # 禁用代理自动检测，强制直连
```

> 修改系统时区需要权限：Windows 请以**管理员身份**运行终端；macOS/Linux 请使用 `sudo`。

### 检测原理（两步解耦）

1. **出口 IP**：请求 `claude.ai/cdn-cgi/trace`（备选 cloudflare/ipify 等）——得到 Claude 视角的出口 IP。如果系统存在代理配置（Windows 注册表 / macOS scutil / 环境变量），会自动探测端口存活后启用，兼容 Clash/V2Ray 规则分流模式；
2. **地理定位**：用带 IP 参数的 API（`ipwho.is/<ip>` 等）查询该出口 IP 的时区——查询走什么路由不影响结果。

### 秒级切换原理（watch 模式）

地理位置 API 有免费额度限制（ipwho.is 10k 次/月、ipapi.co 1000 次/天），直接秒级轮询会迅速耗尽。因此 watch 模式采用**两层检测**：

1. **快速轮询**：按 `-w` 间隔请求轻量 IP-echo 服务（`claude.ai/cdn-cgi/trace`、ipify 等，纯文本响应、限额宽松、延迟约 100ms），只取出口 IP；
2. **变化才查询**：仅当出口 IP 与上一轮不同时，才调用地理位置 API 解析时区，结果缓存到 `~/.ip-tz-sync-cache.json` —— 切回历史节点时零网络查询，瞬时切换。

实际切换延迟 ≈ 轮询间隔 + 地理查询（新节点约 1~2s，缓存节点为 0）。`-w 1` 时整体 **1~3 秒内完成**；`tzutil` 本身执行仅几十毫秒。

### 注意

- 代理自动检测需要 Node.js ≥ 24.5（用到内置的 env 代理支持）；低版本 Node 请显式设置 `HTTPS_PROXY` 环境变量。
- 时区变化不影响系统时钟的绝对时刻（UTC 时间不变），只影响本地时间的显示。
- 时区只是风控指纹之一，请同时注意浏览器语言、WebRTC 泄漏等其他信号。

---

## English

### Why (the Claude use case)

Claude (Anthropic) enforces strict regional risk control: besides checking where your IP is located, it cross-checks **fingerprint consistency — e.g. your system timezone vs. your IP's geolocation**. After switching VPN nodes, if your system timezone still says `Asia/Shanghai` while your IP exits in the US, that mismatch is a strong risk signal that can contribute to account bans.

`ip-tz-sync` makes your system timezone **follow your VPN exit IP within seconds**: switch to a US node and the system timezone becomes `America/New_York`; switch to Japan and it becomes `Asia/Tokyo`. Fingerprint consistency is handled for you — no manual setup.

> Also useful for any service that cross-checks IP/timezone consistency (Google, Netflix, etc.).

### Features

- Zero-dependency pure JavaScript, single-file CLI (Node.js ≥ 18), ~11 KB package
- **Measures the exit IP from Claude's point of view**: queries `claude.ai/cdn-cgi/trace` first, so the detected IP is exactly what Claude's servers see, following the same routing rules as your browser
- **Automatic system-proxy detection**: works with rule-based split tunneling (Clash/V2Ray browser extensions, even when the system-proxy switch is off); `--proxy` to set one explicitly, `--no-proxy` to force direct
- Cross-platform: Windows (`tzutil`) / macOS (`systemsetup`) / Linux (`timedatectl`, falls back to `/etc/localtime` without systemd)
- Cross-architecture: x64 / arm64 / arm / ppc64le — runs anywhere Node.js runs, no native modules
- 3 geolocation APIs with automatic failover (ipwho.is → ipapi.co → ip-api.com)
- Windows timezone mapping built from official Unicode CLDR data (446 IANA zones), refined by the exit IP's country code
- Optional desktop watermark (**off by default**, enabled via `--watermark`): native WPF overlay on Windows, zero extra dependencies

### Desktop watermark (optional, off by default)

Once the system timezone is changed to the proxy exit's timezone, the taskbar clock shows "fake" time. The watermark keeps a translucent overlay at the bottom-right of your desktop (always-on-top, click-through, not in the taskbar) so you can always see the real time:

```
2026-10-19  21:05:33                    ← real time at your physical location
Real Asia/Shanghai (UTC+08:00)          ← from direct-connection detection
Sys  America/Los_Angeles (UTC-07:00)    ← the timezone website fingerprints see
```

```bash
ip-tz-sync --watermark        # start (detects your physical zone once via direct connection, then cached)
ip-tz-sync --watermark-stop   # stop
```

The main clock converts UTC into your physical timezone — it is unaffected by later system-timezone changes. Windows only for now.

### Install

```bash
npm i -g ip-tz-sync     # global install
npx ip-tz-sync          # or run without installing
```

### Usage

```bash
ip-tz-sync              # detect outbound IP and set system timezone
ip-tz-sync -p           # print detection only (IP / location / timezone)
ip-tz-sync -n           # dry run: show what would change
ip-tz-sync -w 2         # watch mode: poll outbound IP every 2s, switch timezone in seconds
ip-tz-sync --tz Asia/Tokyo   # skip detection, set a specific timezone
ip-tz-sync --proxy http://127.0.0.1:7897   # use an explicit local proxy port
ip-tz-sync --no-proxy        # disable proxy auto-detection, force direct
```

> Changing the system timezone requires privileges: run the terminal **as Administrator** on Windows; use `sudo` on macOS/Linux.

### How detection works (two decoupled steps)

1. **Exit IP**: query `claude.ai/cdn-cgi/trace` (fallback: cloudflare/ipify/...) — the exit IP as Claude sees it. If a system proxy is configured (Windows registry / macOS scutil / env vars), it is probed and used automatically, compatible with rule-based split tunneling;
2. **Geolocation**: look up that exit IP via IP-parameterized APIs (`ipwho.is/<ip>` etc.) — the lookup's own route doesn't affect the result.

### How second-level switching works (watch mode)

Geolocation APIs have free-tier limits (ipwho.is 10k/month, ipapi.co 1000/day), so polling them every second would burn through the quota in hours. Watch mode therefore uses **two-tier detection**:

1. **Fast polling**: at the `-w` interval, query lightweight IP-echo services (`claude.ai/cdn-cgi/trace`, ipify, etc. — plain-text responses, generous limits, ~100ms latency) to get just the outbound IP;
2. **Query on change only**: the geolocation API is called only when the IP actually changes, and results are cached in `~/.ip-tz-sync-cache.json` — switching back to a previously-seen node requires zero network calls and is instant.

Effective switch latency ≈ poll interval + geolocation lookup (~1–2s for a new node, 0 for a cached one). With `-w 1` the whole switch completes in **1–3 seconds**; `tzutil` itself takes only tens of milliseconds.

### Notes

- Proxy auto-detection requires Node.js ≥ 24.5 (uses the built-in env-proxy support); on older Node, set the `HTTPS_PROXY` environment variable explicitly.
- Changing the timezone does not change the absolute clock (UTC time is unaffected), only how local time is displayed.
- Timezone is only one risk-control fingerprint — also mind browser language, WebRTC leaks, and other signals.

## License

MIT
