/**
 * dsh-fairy-theme — 宿主侧（Node）。
 *
 * 职责只有两件：
 *   1. 把 Fairy 美术素材（动画帧 / SVG / 头像）与 44 段语音播种到 ~/.dsh/fairy-theme/，
 *      并通过 webServer 提供只读静态路由给浏览器端。
 *   2. 读写一份 JSON 配置（主题开关、配色模式、音量等）。
 *
 * 不做的事：
 *   - 不注入任何 CSS（配色全在客户端做，用官方的 --dsw-* 变量体系）
 *   - 不抓 DOM
 *   - 不跑 TTS、不联网
 */
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, copyFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-fairy-theme';

/**
 * 必须显式声明依赖的服务 —— 缺这行时 cordis 不会调用 apply()，
 * 插件表现为「装好了、在层栈里、却毫无动静」（实测踩过，2026-09-16）。
 * webServer 用于注册素材路由；缺失时插件应保持沉默而不是崩掉。
 */
export const inject = ['webServer'];

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROUTE_BASE = '/fairy-theme';
// ⚠️ 2026-09-16 修：**前缀不能带尾斜杠**。
//
// webServer 的匹配实现（dsh-host-webserver/lib/index.js 的 match()）是：
//     for (const [prefix, route] of this.prefixes) {
//       if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
//       …
//     }
// 它自己会补一个 '/' 再比对。所以若注册时写成 '/fairy-theme/asset/'，
// 匹配条件就变成要求 pathname 以 **'/fairy-theme/asset//'**（双斜杠）开头
// —— 永远不可能成立，静态资源路由**静默 404**。
//
// 症状极具迷惑性：exact 路由（/status、/manifest）全部正常 200，
// 只有 prefix 路由的素材取不到 → 浮动 Fairy 渲染成"破图 + alt 文字"。
const ASSET_PREFIX = `${ROUTE_BASE}/asset`;   // 不带尾斜杠
const ASSET_URL_PREFIX = `${ASSET_PREFIX}/`;  // 供 handler 切路径用（带尾斜杠）
const PKG_ASSETS = path.join(PLUGIN_ROOT, 'assets');

/**
 * 日志。**同时**写控制台和落盘文件 ——
 * Electron 主进程的 console.log 不进 DSH 的日志文件，排查时会误判成
 * 「插件没加载」（2026-09-16 实测踩过）。落盘文件是可靠的激活证据。
 */
const LOG_FILE = path.join(homedir(), '.dsh', 'fairy-theme', 'plugin.log');
function log(level, message, detail) {
  const line = `[fairy-theme] ${message}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (detail === undefined) sink(line);
  else sink(line, detail);
  try {
    const stamp = new Date().toISOString();
    const extra = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${stamp} ${level.toUpperCase()} ${message}${extra}\n`, 'utf8');
  } catch { /* 落盘失败不影响功能 */ }
}

/** DSH 数据目录：优先 $DSH_HOME，回落 ~/.dsh。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return path.join(homedir(), '.dsh');
}

const DATA_DIR = path.join(resolveDshHome(), 'fairy-theme');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SOUNDS_DIR = path.join(DATA_DIR, 'sounds');
const FRAMES_DIR = path.join(DATA_DIR, 'frames');
/** 客户端诊断回流落盘处（见 handlers.diag）。 */
const DIAG_FILE = path.join(DATA_DIR, 'client-diag.json');

// ---------------------------------------------------------------- 素材清单

/** 44 段语音的文件名清单。
 *  ⚠️ 语音文件本身**不随本仓库分发**（第三方版权，来源不可追溯，见 ASSETS.md）。
 *     这里只是文件名常量：使用者自行把素材放进 assets/ 后，播种逻辑按此清单核对。 */
const SOUND_FILES = [
  'aborted.wav', 'activity-1.wav', 'activity-2.wav', 'activity-3.wav',
  'compact-auto.wav', 'compact-manual.wav', 'compact-success.wav', 'compaction-failed.wav',
  'context-warning.wav', 'error.wav', 'goodbye-1.wav', 'goodbye-2.wav', 'goodbye-3.wav',
  'goodbye-4.wav', 'goodbye-5.wav', 'goodbye-6.wav', 'input.wav', 'model-switch.wav',
  'network-error.wav', 'new-session.wav', 'permission-1.wav', 'permission-2.wav',
  'permission-3.wav', 'permission-approved.wav', 'permission-denied.wav',
  'quota-warning.wav', 'retry.wav', 'session-switch.wav', 'success-1.wav', 'success-2.wav',
  'success-3.wav', 'task-start-1.wav', 'task-start-2.wav', 'task-start-3.wav', 'task-start-4.wav',
  'voice-off.wav', 'voice-on.wav', 'welcome-1.wav', 'welcome-2.wav', 'welcome-3.wav',
  'welcome-4.wav', 'welcome-5.wav', 'welcome-6.wav', 'welcome-7.wav',
];

/** 动画帧：dark / light 各 120 张 256×256 PNG。 */
const FRAME_COUNT = 120;
const VARIANTS = ['dark', 'light'];

/** 静态图（头像等）。 */
const IMAGE_FILES = ['fairy.svg', 'avatar-circle.png', 'avatar-square.png'];

const ALL_ASSETS = new Set([
  ...SOUND_FILES,
  ...IMAGE_FILES,
  ...VARIANTS.flatMap((v) => Array.from({ length: FRAME_COUNT }, (_, i) => `frames/${v}/${String(i).padStart(3, '0')}.png`)),
]);

// ---------------------------------------------------------------- 配置

function defaultConfig() {
  return {
    theme: {
      enabled: true,
      /** 'auto' | 'dark' | 'light' */
      mode: 'auto',
      /** 是否给界面加 HDD 风格的点缀（扫描线/光晕） */
      ornaments: true,
    },
    fairy: {
      enabled: true,
      /** 浮动 Fairy 的大小（px） */
      size: 96,
      /** 停靠角落：bottom-right | bottom-left | top-right | top-left */
      corner: 'bottom-right',
      /** 是否跟随 agent 状态改变表情/动效 */
      reactToState: true,
    },
    voice: {
      enabled: false,
      volume: 0.6,
    },
  };
}

let cachedConfig = null;
let writeChain = Promise.resolve();

function mergeConfig(raw) {
  const base = defaultConfig();
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = { ...base };
  for (const key of Object.keys(base)) {
    const src = input[key];
    if (src && typeof src === 'object') out[key] = { ...base[key], ...src };
  }
  // 收敛已知取值
  if (!['auto', 'dark', 'light'].includes(out.theme.mode)) out.theme.mode = 'auto';
  if (!['bottom-right', 'bottom-left', 'top-right', 'top-left'].includes(out.fairy.corner)) {
    out.fairy.corner = 'bottom-right';
  }
  out.fairy.size = Math.min(320, Math.max(32, Number(out.fairy.size) || 96));
  out.voice.volume = Math.min(1, Math.max(0, Number(out.voice.volume) ?? 0.6));
  return out;
}

async function readConfig() {
  let raw = {};
  try {
    raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') log('warn', '配置读取失败，改用默认值', error?.message || error);
  }
  cachedConfig = mergeConfig(raw);
  return cachedConfig;
}

async function writeConfig(patch) {
  const current = cachedConfig ?? (await readConfig());
  const next = mergeConfig({ ...current, ...patch });
  writeChain = writeChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  });
  await writeChain;
  cachedConfig = next;
  return next;
}

// ---------------------------------------------------------------- 播种

/** 把包内 assets/ 幂等复制到数据目录。已存在且大小一致就跳过。 */
async function seed() {
  let copied = 0;
  await mkdir(SOUNDS_DIR, { recursive: true });
  await mkdir(FRAMES_DIR, { recursive: true });

  const jobs = [];
  for (const f of SOUND_FILES) {
    jobs.push([path.join(PKG_ASSETS, 'sounds', f), path.join(SOUNDS_DIR, f)]);
  }
  for (const f of IMAGE_FILES) {
    jobs.push([path.join(PKG_ASSETS, f), path.join(DATA_DIR, f)]);
  }
  for (const v of VARIANTS) {
    for (let i = 0; i < FRAME_COUNT; i++) {
      const n = `${String(i).padStart(3, '0')}.png`;
      jobs.push([path.join(PKG_ASSETS, 'frames', v, n), path.join(FRAMES_DIR, v, n)]);
    }
  }

  await Promise.all(VARIANTS.map((v) => mkdir(path.join(FRAMES_DIR, v), { recursive: true })));

  for (const [src, dst] of jobs) {
    if (!existsSync(src)) continue;
    try {
      const [a, b] = await Promise.all([stat(src), stat(dst).catch(() => null)]);
      if (b && b.size === a.size) continue;
      await copyFile(src, dst);
      copied++;
    } catch (error) {
      log('warn', `播种失败 ${path.basename(dst)}`, error?.message || error);
    }
  }
  if (copied > 0) log('info', `已播种 ${copied} 个素材到 ${DATA_DIR}`);
  return DATA_DIR;
}

async function readJsonBody(req, limitBytes = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, value) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml', '.wav': 'audio/wav' };

export function apply(ctx) {
  // 加载留痕：日后判断「插件到底有没有被激活」不用再靠猜。
  log('info', `宿主侧已激活（数据目录 ${DATA_DIR}）`);

  void (async () => {
    await readConfig();
    await seed();
    log('info', `素材就绪：${SOUND_FILES.length} 段语音、${FRAME_COUNT} 张帧图`);
  })().catch((error) => log('warn', '启动初始化失败', error?.message || error));

  const handlers = {
    /**
     * 诊断回流。客户端在浏览器里，外部读不到它的 globalThis / DOM，
     * 于是让 client 主动把内部状态 POST 回来，这里落盘成文件供离线判读。
     *
     * 有了它，「插槽注册成功没」「配置加载成功没」「React 渲染到哪一步」
     * 都变成**可读的文件**，不必再靠推断。这是本项目「写入 ≠ 生效」原则的落实。
     */
    async diag(req, res) {
      if (req.method === 'GET') {
        try {
          const raw = await readFile(DIAG_FILE, 'utf8');
          sendJson(res, 200, { ok: true, diag: JSON.parse(raw) });
        } catch {
          sendJson(res, 200, { ok: false, error: '尚无诊断上报' });
        }
        return;
      }
      try {
        const body = await readJsonBody(req);
        const record = {
          receivedAt: new Date().toISOString(),
          ...body,
        };
        await mkdir(DATA_DIR, { recursive: true });
        await writeFile(DIAG_FILE, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        log('info', `收到客户端诊断：slots=${body?.hasSlots} configReady=${body?.configReady} floating=${body?.floating} settings=${body?.settings}`);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message || error) });
      }
    },

    async status(req, res) {
      const config = cachedConfig ?? (await readConfig());
      const sounds = (await readdir(SOUNDS_DIR).catch(() => [])).filter((f) => f.endsWith('.wav'));
      const frames = {};
      for (const v of VARIANTS) {
        frames[v] = (await readdir(path.join(FRAMES_DIR, v)).catch(() => [])).filter((f) => f.endsWith('.png')).length;
      }
      sendJson(res, 200, {
        ok: true,
        dataDir: DATA_DIR,
        sounds: sounds.length,
        expectSounds: SOUND_FILES.length,
        frames,
        expectFrames: FRAME_COUNT,
        config,
      });
    },

    async manifest(req, res) {
      const config = cachedConfig ?? (await readConfig());
      sendJson(res, 200, {
        ok: true,
        routeBase: ROUTE_BASE,
        sounds: SOUND_FILES,
        images: IMAGE_FILES,
        frames: { variants: VARIANTS, count: FRAME_COUNT, intervalMs: 50, size: 256 },
        config,
      });
    },

    async config(req, res) {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, config: cachedConfig ?? (await readConfig()) });
        return;
      }
      if (req.method === 'POST') {
        try {
          const patch = await readJsonBody(req);
          const next = await writeConfig(patch);
          sendJson(res, 200, { ok: true, config: next });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message || error) });
        }
        return;
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
    },

    /** 素材静态服务：只允许清单内的相对路径，挡目录穿越。 */
    async asset(req, res) {
      let rel = '';
      try {
        // 用带尾斜杠的 ASSET_URL_PREFIX 切分（注册用的 ASSET_PREFIX 不带尾斜杠）。
        rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(ASSET_URL_PREFIX.length));
      } catch {
        sendJson(res, 400, { ok: false, error: 'bad path' });
        return;
      }
      rel = rel.replace(/^\/+/, '');
      if (rel === '' || rel.includes('\\') || rel.includes('..') || !ALL_ASSETS.has(rel)) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      const file = path.join(DATA_DIR, rel);
      let info;
      try {
        info = await stat(file);
      } catch {
        sendJson(res, 404, { ok: false, error: 'missing on disk' });
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'public, max-age=86400',
        ETag: etag,
      });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    },
  };

  // 与 dsh-fairy-voice 1.0.5 同一写法：register 的返回值即 disposer。
  // 这里刻意**不**用 ws.effect —— 少依赖一个方法存在性。
  ctx.inject(['webServer'], (ws) => {
    const disposers = [
      // ★ 诊断回流：客户端无法被外部读取（DevTools 打不开、globalThis 拿不到），
      //   于是让 client 把内部状态 POST 回来，宿主落盘成文件。
      //   这是「写入 ≠ 生效」原则下唯一能真正看到 client 内部的办法。
      ws.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/diag`, handler: handlers.diag }),
      ws.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/status`, handler: handlers.status }),
      ws.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/manifest`, handler: handlers.manifest }),
      ws.webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/config`, handler: handlers.config }),
      ws.webServer.register({ kind: 'prefix', path: ASSET_PREFIX, handler: handlers.asset }),
    ];
    return () => disposers.forEach((dispose) => { try { dispose?.(); } catch { /* 卸载期忽略 */ } });
  });
}
