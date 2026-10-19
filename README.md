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
- 跨平台：Windows（`tzutil`）/ macOS（`systemsetup`）/ Linux（`timedatectl`，无 systemd 时回退 `/etc/localtime`）
- 跨 CPU 架构：x64 / arm64 / arm / ppc64le —— 凡是 Node.js 能跑的架构都能用，无原生模块
- 4 个地理位置 API 自动故障转移（ipwho.is → ipapi.co → worldtimeapi.org → ip-api.com）
- Windows 时区映射基于 Unicode CLDR 官方数据（446 个 IANA 时区），并按 IP 所在国家码做精细化匹配

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
```

> 修改系统时区需要权限：Windows 请以**管理员身份**运行终端；macOS/Linux 请使用 `sudo`。

### 秒级切换原理（watch 模式）

地理位置 API 有免费额度限制（ipwho.is 10k 次/月、ipapi.co 1000 次/天），直接秒级轮询会迅速耗尽。因此 watch 模式采用**两层检测**：

1. **快速轮询**：按 `-w` 间隔请求轻量 IP-echo 服务（Cloudflare `cdn-cgi/trace`、ipify 等，纯文本响应、限额宽松、延迟约 100ms），只取出口 IP；
2. **变化才查询**：仅当出口 IP 与上一轮不同时，才调用地理位置 API 解析时区，结果缓存到 `~/.ip-tz-sync-cache.json` —— 切回历史节点时零网络查询，瞬时切换。

实际切换延迟 ≈ 轮询间隔 + 地理查询（新节点约 1~2s，缓存节点为 0）。`-w 1` 时整体 **1~3 秒内完成**；`tzutil` 本身执行仅几十毫秒。

### 注意

- 检测走的是本机 HTTPS 请求，只有 **TUN/全局模式** 的代理才会被正确识别；仅浏览器级代理（如 SwitchyOmega）时检测到的是直连 IP。
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
- Cross-platform: Windows (`tzutil`) / macOS (`systemsetup`) / Linux (`timedatectl`, falls back to `/etc/localtime` without systemd)
- Cross-architecture: x64 / arm64 / arm / ppc64le — runs anywhere Node.js runs, no native modules
- 4 geolocation APIs with automatic failover (ipwho.is → ipapi.co → worldtimeapi.org → ip-api.com)
- Windows timezone mapping built from official Unicode CLDR data (446 IANA zones), refined by the exit IP's country code

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
```

> Changing the system timezone requires privileges: run the terminal **as Administrator** on Windows; use `sudo` on macOS/Linux.

### How second-level switching works (watch mode)

Geolocation APIs have free-tier limits (ipwho.is 10k/month, ipapi.co 1000/day), so polling them every second would burn through the quota in hours. Watch mode therefore uses **two-tier detection**:

1. **Fast polling**: at the `-w` interval, query lightweight IP-echo services (Cloudflare `cdn-cgi/trace`, ipify, etc. — plain-text responses, generous limits, ~100ms latency) to get just the outbound IP;
2. **Query on change only**: the geolocation API is called only when the IP actually changes, and results are cached in `~/.ip-tz-sync-cache.json` — switching back to a previously-seen node requires zero network calls and is instant.

Effective switch latency ≈ poll interval + geolocation lookup (~1–2s for a new node, 0 for a cached one). With `-w 1` the whole switch completes in **1–3 seconds**; `tzutil` itself takes only tens of milliseconds.

### Notes

- Detection uses local HTTPS requests, so only **TUN/global-mode** proxies are recognized; with browser-level proxies (e.g. SwitchyOmega) you'll see your direct-connection IP.
- Changing the timezone does not change the absolute clock (UTC time is unaffected), only how local time is displayed.
- Timezone is only one risk-control fingerprint — also mind browser language, WebRTC leaks, and other signals.

## License

MIT
