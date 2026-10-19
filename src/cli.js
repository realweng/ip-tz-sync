#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const WIN_ZONES = require('./win-zones.json');

const VERSION = '0.0.3';
const TIMEOUT_MS = 8000;
const CACHE_FILE = path.join(os.homedir(), '.ip-tz-sync-cache.json');
const WM_PID_FILE = path.join(os.homedir(), '.ip-tz-sync-watermark.pid');
const REAL_ZONE_FILE = path.join(os.homedir(), '.ip-tz-sync-realzone.json');

// 地理位置 API: 传入出口 IP 查询其位置, 返回 { ip, iana, country, countryCode, city }
// 有免费额度限制, 只在出口 IP 变化时调用
const GEO_PROVIDERS = [
  {
    name: 'ipwho.is',
    url: (ip) => `https://ipwho.is/${ip}`,
    parse: (j) => ({
      ip: j.ip,
      iana: j.timezone && j.timezone.id,
      country: j.country,
      countryCode: j.country_code,
      city: j.city,
    }),
  },
  {
    name: 'ipapi.co',
    url: (ip) => `https://ipapi.co/${ip}/json/`,
    parse: (j) => ({
      ip: j.ip,
      iana: j.timezone,
      country: j.country_name,
      countryCode: j.country_code,
      city: j.city,
    }),
  },
  {
    name: 'ip-api.com',
    url: (ip) => `http://ip-api.com/json/${ip}?fields=status,query,country,countryCode,city,timezone`,
    parse: (j) => ({
      ip: j.query,
      iana: j.timezone,
      country: j.country,
      countryCode: j.countryCode,
      city: j.city,
    }),
  },
];

// 轻量 IP-echo 服务: 返回纯文本 IP, 响应小、限额宽松, 适合秒级轮询
// 首选 claude.ai (Cloudflare 托管): 测出的正是 Claude 服务器看到的出口 IP,
// 与浏览器访问 Claude 走完全相同的路由规则
const ECHO_PROVIDERS = [
  {
    name: 'claude.ai',
    url: 'https://claude.ai/cdn-cgi/trace',
    parse: (t) => (t.match(/^ip=(.+)$/m) || [])[1],
  },
  {
    name: 'cloudflare',
    url: 'https://cloudflare.com/cdn-cgi/trace',
    parse: (t) => (t.match(/^ip=(.+)$/m) || [])[1],
  },
  { name: 'ipify', url: 'https://api64.ipify.org', parse: (t) => t.trim() },
  { name: 'icanhazip', url: 'https://icanhazip.com', parse: (t) => t.trim() },
  { name: 'ifconfig.me', url: 'https://ifconfig.me/ip', parse: (t) => t.trim() },
];

function parseArgs(argv) {
  const opts = { watch: 0, dryRun: false, printOnly: false, tz: null, api: null, proxy: null, noProxy: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-n' || a === '--dry-run') opts.dryRun = true;
    else if (a === '-p' || a === '--print') opts.printOnly = true;
    else if (a === '--no-proxy') opts.noProxy = true;
    else if (a === '--watermark') opts.watermark = 'start';
    else if (a === '--watermark-stop') opts.watermark = 'stop';
    else if (a === '--proxy') {
      opts.proxy = argv[++i];
      if (!opts.proxy) die('--proxy 需要代理地址, 如 http://127.0.0.1:7897');
    } else if (a === '-w' || a === '--watch') {
      const v = Number(argv[i + 1]);
      if (!Number.isFinite(v) || v < 1) die('--watch 需要一个 >= 1 的秒数');
      opts.watch = v;
      i++;
    } else if (a === '--tz') {
      opts.tz = argv[++i];
      if (!opts.tz) die('--tz 需要一个 IANA 时区名, 如 America/New_York');
    } else if (a === '--api') {
      opts.api = argv[++i];
    } else if (a === '-h' || a === '--help') {
      usage(0);
    } else if (a === '-v' || a === '--version') {
      console.log(VERSION);
      process.exit(0);
    } else {
      die(`未知参数: ${a} (用 --help 查看用法)`);
    }
  }
  return opts;
}

function usage(code) {
  console.log(`ip-tz-sync ${VERSION} — 根据出口 IP 地理位置自动设置系统时区

用法:
  ip-tz-sync              检测出口 IP 并设置系统时区
  ip-tz-sync -p           只打印检测结果, 不改系统
  ip-tz-sync -n           演练: 打印将要执行的操作, 不实际修改
  ip-tz-sync -w 2         watch 模式: 每 2 秒检测出口 IP, 变化时自动切换时区
  ip-tz-sync --tz Asia/Tokyo   跳过 IP 检测, 直接设置指定时区
  ip-tz-sync --api ipapi.co    指定地理位置 API

选项:
  -p, --print      仅打印出口 IP / 位置 / 时区
  -n, --dry-run    只显示操作, 不修改系统
  -w, --watch <s>  轮询间隔秒数 (最小 1)
      --tz <iana>  手动指定 IANA 时区
      --api <name> 指定地理位置 API: ${GEO_PROVIDERS.map((p) => p.name).join(', ')}
      --proxy <url>  指定代理 (如 http://127.0.0.1:7897), 用于浏览器代理/VPN 非全局场景
      --no-proxy   禁用代理自动检测, 强制直连
      --watermark  开启桌面水印 (默认关闭): 右下角常驻显示实际地区真实时间+系统时区 (Windows)
      --watermark-stop  关闭水印
  -v, --version    版本
  -h, --help       帮助

代理检测顺序: --proxy > HTTPS_PROXY 等环境变量 > 系统自动检测 (Windows 注册表 /
macOS scutil, 探测端口存活后才启用)。浏览器代理插件场景下系统代理开关即使
关闭, 只要端口存活也会自动使用。

watch 模式为两层检测: 用轻量 IP-echo 服务秒级轮询出口 IP, 仅当 IP 变化时
才调用地理位置 API (有额度限制), 且结果缓存于 ${CACHE_FILE}
切回历史节点时零网络查询、瞬时切换。

支持平台: Windows (tzutil) / macOS (systemsetup) / Linux (timedatectl 或 /etc/localtime)
纯 JavaScript, 无原生依赖, x64 / arm64 / 任何 Node >= 18 支持的 CPU 均可运行。`);
  process.exit(code);
}

function die(msg) {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

async function fetchUrl(url, asJson) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': `ip-tz-sync/${VERSION}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return asJson ? await res.json() : await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function detectGeo(ip, apiName) {
  const list = apiName
    ? GEO_PROVIDERS.filter((p) => p.name === apiName)
    : GEO_PROVIDERS;
  if (apiName && list.length === 0) die(`未知 API: ${apiName}`);

  let lastErr;
  for (const p of list) {
    try {
      const info = p.parse(await fetchUrl(p.url(ip), true));
      if (info && info.iana && isValidIana(info.iana)) {
        info.provider = p.name;
        info.ip = info.ip || ip;
        return info;
      }
      lastErr = new Error('返回数据无效');
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`所有地理位置 API 均失败, 最后错误: ${lastErr && lastErr.message}`);
}

// 仅探测出口 IP (轻量, 秒级轮询用)
async function detectIp() {
  let lastErr;
  for (const p of ECHO_PROVIDERS) {
    try {
      const ip = p.parse(await fetchUrl(p.url, false));
      if (ip && /^[0-9a-fA-F.:]+$/.test(ip)) return ip;
      lastErr = new Error('返回数据无效');
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`所有 IP-echo 服务均失败, 最后错误: ${lastErr && lastErr.message}`);
}

function isValidIana(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function currentIana() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// IANA -> Windows 时区 ID, 优先按国家码匹配, 否则用 CLDR 默认 (territory=001)
function toWindowsZone(iana, countryCode) {
  let entry = WIN_ZONES[iana];
  if (!entry) {
    // 处理别名, 如 Europe/Kiev vs Europe/Kyiv
    const alias = resolveAlias(iana);
    if (alias) entry = WIN_ZONES[alias];
  }
  if (!entry) return null;
  if (countryCode && entry[countryCode]) return entry[countryCode];
  return entry.d || null;
}

function resolveAlias(iana) {
  const ALIASES = {
    'Europe/Kyiv': 'Europe/Kiev',
    'Asia/Calcutta': 'Asia/Kolkata',
    'America/Nuuk': 'America/Godthab',
    'Asia/Kathmandu': 'Asia/Katmandu',
    'Pacific/Kanton': 'Pacific/Enderbury',
  };
  if (ALIASES[iana]) return ALIASES[iana];
  const rev = Object.keys(ALIASES).find((k) => ALIASES[k] === iana);
  return rev && WIN_ZONES[rev] ? rev : null;
}

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function setWindows(iana, countryCode) {
  const winId = toWindowsZone(iana, countryCode);
  if (!winId) {
    die(`找不到 ${iana} 对应的 Windows 时区 ID, 请提 issue 或用 Linux/macOS`);
  }
  try {
    run('tzutil', ['/s', winId]);
    return `tzutil /s "${winId}"`;
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    throw new Error(
      `设置失败 (需要管理员权限, 请以管理员身份运行终端): ${stderr.trim() || e.message}`
    );
  }
}

function setDarwin(iana) {
  try {
    run('systemsetup', ['-settimezone', iana]);
    return `systemsetup -settimezone ${iana}`;
  } catch (e) {
    throw new Error(`设置失败 (需要 root, 请用 sudo 运行): ${e.message}`);
  }
}

function setLinux(iana) {
  // 优先 timedatectl (systemd)
  try {
    run('timedatectl', ['set-timezone', iana]);
    return `timedatectl set-timezone ${iana}`;
  } catch {
    /* fall through */
  }
  // 回退: 无 systemd 的环境 (Alpine/容器/BusyBox), 直接改 /etc/localtime
  const zonefile = path.join('/usr/share/zoneinfo', iana);
  if (!fs.existsSync(zonefile)) {
    throw new Error(`系统缺少时区数据文件 ${zonefile} (Alpine 请先 apk add tzdata)`);
  }
  try {
    try {
      fs.rmSync('/etc/localtime');
    } catch {
      /* not exist */
    }
    fs.symlinkSync(zonefile, '/etc/localtime');
    fs.writeFileSync('/etc/timezone', iana + '\n');
    return `/etc/localtime -> ${zonefile}`;
  } catch (e) {
    throw new Error(`设置失败 (需要 root, 请用 sudo 运行): ${e.message}`);
  }
}

function setTimezone(iana, countryCode, dryRun) {
  const platform = process.platform;
  if (dryRun) {
    if (platform === 'win32') {
      const winId = toWindowsZone(iana, countryCode);
      return `[dry-run] 将执行: tzutil /s "${winId || '?'}"`;
    }
    if (platform === 'darwin') return `[dry-run] 将执行: systemsetup -settimezone ${iana}`;
    return `[dry-run] 将执行: timedatectl set-timezone ${iana} (或回退 /etc/localtime)`;
  }
  if (platform === 'win32') return setWindows(iana, countryCode);
  if (platform === 'darwin') return setDarwin(iana);
  return setLinux(iana); // linux / freebsd / openbsd / aix / sunos 等
}

function describe(info) {
  const where = [info.city, info.country].filter(Boolean).join(', ');
  return `${info.ip}  ${where}  ${info.iana}${info.cached ? '  (缓存)' : `  (${info.provider})`}`;
}

// 应用时区 (如需要)
function applyTz(info, opts) {
  if (opts.printOnly) {
    console.log(`时区: ${info.iana}\n当前系统时区: ${currentIana() || '未知'}`);
    return;
  }
  const cur = currentIana();
  if (cur === info.iana && !opts.dryRun) {
    console.log(`系统时区已是 ${info.iana}, 无需变更`);
    return;
  }
  const action = setTimezone(info.iana, info.countryCode, opts.dryRun);
  console.log(`${cur || '未知'} -> ${info.iana}  OK  [${action}]`);
}

// ---------- IP -> 时区 缓存 ----------
function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length > 500) {
    for (const k of keys.slice(0, keys.length - 500)) delete cache[k];
  }
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {
    /* 缓存写不进去也无妨 */
  }
}

async function geoForIp(ip, opts, cache) {
  const hit = ip && cache[ip];
  if (hit && isValidIana(hit.iana)) {
    return { ip, iana: hit.iana, countryCode: hit.cc, city: hit.city, country: hit.country, cached: true };
  }
  const info = await detectGeo(ip, opts.api);
  if (info.ip) {
    cache[info.ip] = { iana: info.iana, cc: info.countryCode, city: info.city, country: info.country };
    saveCache(cache);
  }
  return info;
}

// ---------- 代理支持 ----------
// Node >= 24.5 支持 NODE_USE_ENV_PROXY, 运行时设置即可让 fetch 走代理 (零依赖)
function parseWinProxyServer(s) {
  // 格式: "127.0.0.1:7897" 或 "http=host:port;https=host:port;socks=host:port"
  if (!s) return null;
  let addr = s.trim();
  if (addr.includes('=')) {
    const parts = {};
    for (const p of addr.split(';')) {
      const [k, v] = p.split('=');
      if (k && v) parts[k.trim().toLowerCase()] = v.trim();
    }
    addr = parts.https || parts.http || parts.socks;
    if (!addr) return null;
  }
  return 'http://' + addr.replace(/^[a-z]+:\/\//i, '');
}

function detectSystemProxy() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'],
        { encoding: 'utf8' }
      );
      const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
      return m ? parseWinProxyServer(m[1]) : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8' });
      const enabled = /HTTPSEnable\s*:\s*1/.test(out) || /HTTPEnable\s*:\s*1/.test(out);
      const host = (out.match(/HTTPS?Proxy\s*:\s*(\S+)/) || [])[1];
      const port = (out.match(/HTTPS?Port\s*:\s*(\d+)/) || [])[1];
      if (enabled && host) return `http://${host}:${port || 8080}`;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function probeProxy(proxyUrl) {
  return new Promise((resolve) => {
    try {
      const u = new URL(proxyUrl);
      const sock = net.connect({ host: u.hostname, port: Number(u.port) || 80, timeout: 800 });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      const fail = () => {
        sock.destroy();
        resolve(false);
      };
      sock.once('error', fail);
      sock.once('timeout', fail);
    } catch {
      resolve(false);
    }
  });
}

// 返回实际使用的代理地址, 或 null (直连)
async function setupProxy(opts) {
  if (opts.noProxy) return null;
  let proxy =
    opts.proxy ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null;
  if (!proxy) {
    const sys = detectSystemProxy();
    if (sys && (await probeProxy(sys))) proxy = sys;
  }
  if (!proxy) return null;
  if (!/^[a-z]+:\/\//i.test(proxy)) proxy = 'http://' + proxy;

  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 24 || (maj === 24 && min < 5)) {
    console.error(`警告: 检测到代理 ${proxy}, 但 env 代理需要 Node >= 24.5 (当前 ${process.versions.node}), 将直连检测`);
    return null;
  }
  process.env.NODE_USE_ENV_PROXY = '1';
  process.env.HTTPS_PROXY = proxy;
  process.env.HTTP_PROXY = proxy;
  return proxy;
}

async function once(opts) {
  if (opts.tz) {
    if (!isValidIana(opts.tz)) die(`无效的 IANA 时区: ${opts.tz}`);
    applyTz({ iana: opts.tz, ip: '-', provider: 'manual' }, opts);
    return;
  }
  process.stdout.write('检测出口 IP ... ');
  const ip = await detectIp();
  const info = await geoForIp(ip, opts, loadCache());
  console.log(describe(info));
  applyTz(info, opts);
}

async function watchLoop(opts) {
  const cache = loadCache();
  console.log(`watch 模式: 每 ${opts.watch}s 探测出口 IP, 变化时切换时区, Ctrl+C 退出`);
  let lastIp = null;
  for (;;) {
    try {
      let ip;
      if (opts.tz) {
        // 手动时区模式: 无需探测 IP
        if (lastIp === null) {
          if (!isValidIana(opts.tz)) die(`无效的 IANA 时区: ${opts.tz}`);
          applyTz({ iana: opts.tz, ip: '-', provider: 'manual' }, opts);
          lastIp = 'manual';
        }
      } else {
        ip = await detectIp();
        if (ip !== lastIp) {
          const info = await geoForIp(ip, opts, cache);
          console.log(`出口 IP 变更: ${describe(info)}`);
          applyTz(info, opts);
          lastIp = info.ip || ip;
        }
      }
    } catch (e) {
      console.error(`检测失败: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, opts.watch * 1000));
  }
}

// ---------- 桌面水印 (Windows 原生 WPF) ----------
// 直连探测实际地区时区 (必须在 setupProxy 之前调用, 保证不走代理)
async function detectRealZone() {
  const SELF_PROVIDERS = [
    { url: 'https://ipwho.is/', parse: (j) => ({ iana: j.timezone && j.timezone.id, cc: j.country_code }) },
    { url: 'https://ipapi.co/json/', parse: (j) => ({ iana: j.timezone, cc: j.country_code }) },
  ];
  for (const p of SELF_PROVIDERS) {
    try {
      const info = p.parse(await fetchUrl(p.url, true));
      if (info && info.iana && isValidIana(info.iana)) {
        try {
          fs.writeFileSync(REAL_ZONE_FILE, JSON.stringify(info));
        } catch {
          /* ignore */
        }
        return info;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

async function watermarkStart() {
  if (process.platform !== 'win32') {
    die('水印功能目前仅支持 Windows (零依赖原生 WPF 实现); macOS/Linux 版本规划中');
  }
  watermarkStop(true);
  // 直连探测实际地区; 失败则用上次缓存; 再不行则水印退化为只显示系统时区
  let real = await detectRealZone();
  if (!real) {
    try {
      real = JSON.parse(fs.readFileSync(REAL_ZONE_FILE, 'utf8'));
    } catch {
      /* no cache */
    }
  }
  let realWin = '';
  let realIana = '';
  if (real && real.iana && isValidIana(real.iana)) {
    realIana = real.iana;
    realWin = toWindowsZone(real.iana, real.cc) || '';
    console.log(`实际地区: ${realIana}`);
  } else {
    console.log('未能探测实际地区时区 (直连不可用且无缓存), 水印主行将显示系统时区时间');
  }
  const ps1 = path.join(__dirname, 'watermark.ps1');
  const zoneJson = path.join(__dirname, 'win-zones.json');
  // 经 WMI 创建进程, 使其挂在 WMI 服务下而非本进程, 父进程退出后水印仍能存活
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1}" -ZoneMapPath "${zoneJson}" -RealWinTzId "${realWin}" -RealIana "${realIana}"`;
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd}' }; if ($r.ReturnValue -ne 0) { throw "WMI Create failed: $($r.ReturnValue)" }; $r.ProcessId`,
    ],
    { encoding: 'utf8' }
  );
  const pid = out.trim();
  fs.writeFileSync(WM_PID_FILE, pid);
  console.log(`水印已启动 (pid ${pid}), 显示在桌面右下角; 关闭: ip-tz-sync --watermark-stop`);
}

function watermarkStop(silent) {
  let killed = 0;
  let pid = null;
  try {
    pid = Number(fs.readFileSync(WM_PID_FILE, 'utf8'));
  } catch {
    /* no pid file */
  }
  if (pid) {
    try {
      process.kill(pid);
      killed++;
    } catch {
      /* 进程不存在 */
    }
    try {
      fs.rmSync(WM_PID_FILE);
    } catch {
      /* ignore */
    }
  }
  // 兜底: 按命令行特征找残留的水印进程 (如 pid 文件丢失)
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*watermark.ps1*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; 'killed' }",
        ],
        { encoding: 'utf8' }
      );
      killed += (out.match(/killed/g) || []).length;
    } catch {
      /* ignore */
    }
  }
  if (!silent) console.log(killed > 0 ? '水印已关闭' : '没有正在运行的水印');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.watermark === 'stop') {
    watermarkStop();
    return;
  }
  if (opts.watermark === 'start') await watermarkStart(); // 直连探测须在 setupProxy 之前
  const proxy = await setupProxy(opts);
  if (proxy && !opts.tz) console.log(`使用代理: ${proxy}`);
  if (opts.watermark === 'start' && !opts.watch) return; // 只开水印
  if (!opts.watch) await once(opts);
  else await watchLoop(opts);
}

main().catch((e) => die(e.message));
