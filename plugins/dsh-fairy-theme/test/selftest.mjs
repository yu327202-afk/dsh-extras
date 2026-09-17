#!/usr/bin/env node
/**
 * selftest.mjs —— dsh-fairy-theme 离线自测。
 *
 * 验证四件事，全部不依赖 DSH 运行时：
 *   1. 素材完整性：44 段语音、240 张帧、SVG、两张头像
 *   2. 宿主侧 index.js 可导入，且 apply() 能注册到 mock webServer
 *   3. 客户端 client.js 语法合法，经 mock ModuleLoader 能拿到 factory
 *   4. factory 产出的 apply(ctx) 在 mock cordis ctx 下真的注入了主题 CSS 与两个 slot
 *
 * 任一 FAIL 即以非 0 退出。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('=== dsh-fairy-theme 自测 ===\n');

// ---------------------------------------------------------------- 1. 素材
//
// ⚠️ 素材是【可选】的：Fairy 形象版权属米哈游《绝区零》，语音/帧图/头像来自社区
//    作品，本仓库**有意不分发**这些文件（详见 ASSETS.md）。
//    ⇒ 素材不存在时这些检查降级为 SKIP，而不是 FAIL；
//      素材存在（本地自行补齐）时才做完整性断言。
//    代码路径的检查（下面第 2 节起）不受影响，永远执行。

console.log('— 素材完整性');
const SOUNDS = 44, FRAMES = 120;
const assetsDir = path.join(ROOT, 'assets');
const hasAssets = fs.existsSync(assetsDir) && fs.readdirSync(assetsDir).length > 0;

let skipped = 0;
function checkAsset(name, ok, detail) {
  if (!hasAssets) { skipped++; console.log(`  [SKIP] ${name} — 未随仓库分发（见 ASSETS.md）`); return; }
  check(name, ok, detail);
}

const soundsDir = path.join(ROOT, 'assets', 'sounds');
const soundFiles = fs.existsSync(soundsDir) ? fs.readdirSync(soundsDir).filter((f) => f.endsWith('.wav')) : [];
checkAsset('语音 44 段', soundFiles.length === SOUNDS, `实际 ${soundFiles.length}`);

for (const v of ['dark', 'light']) {
  const dir = path.join(ROOT, 'assets', 'frames', v);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')) : [];
  const nums = files.map((f) => Number(path.basename(f, '.png'))).sort((a, b) => a - b);
  const missing = Array.from({ length: FRAMES }, (_, i) => i).filter((i) => !nums.includes(i));
  checkAsset(`动画帧 ${v} 0-119 无缺号`, files.length === FRAMES && missing.length === 0,
    `实际 ${files.length}，缺 ${missing.length ? missing.length + ' 张' : '无'}`);
}

checkAsset('fairy.svg 存在', fs.existsSync(path.join(ROOT, 'assets', 'fairy.svg')));
checkAsset('头像 circle 存在', fs.existsSync(path.join(ROOT, 'assets', 'avatar-circle.png')));
checkAsset('头像 square 存在', fs.existsSync(path.join(ROOT, 'assets', 'avatar-square.png')));

if (skipped > 0) {
  console.log(`  （${skipped} 项素材检查已跳过 —— 这是本仓库的预期状态）`);
}

// ---------------------------------------------------------------- 2. 宿主侧

console.log('\n— 宿主侧 index.js');
const host = await import(new URL('../lib/index.js', import.meta.url).href);
check('导出 name', host.name === 'dsh-fairy-theme', host.name);
check('导出 apply', typeof host.apply === 'function');

// mock webServer + cordis ctx
const registered = [];
const disposers = [];
const fakeWs = {
  webServer: {
    register(route) {
      registered.push(route);
      const d = () => { const i = registered.indexOf(route); if (i >= 0) registered.splice(i, 1); };
      disposers.push(d);
      return d;
    },
  },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
};
const hostCtx = {
  inject(deps, fn) {
    if (deps.includes('webServer')) fn(fakeWs);
  },
};
let hostThrew = null;
try { host.apply(hostCtx); } catch (e) { hostThrew = e; }
check('apply 不抛异常', hostThrew === null, hostThrew?.message);

await new Promise((r) => setTimeout(r, 300));   // 等种子任务跑完

const paths = registered.map((r) => `${r.kind}:${r.path}`).sort();
// 2026-09-16：新增 /fairy-theme/diag（客户端诊断回流），路由数 4 → 5。
check('注册 5 条路由', registered.length === 5, paths.join(' | '));
check('含 status/manifest/config/diag',
  ['status', 'manifest', 'config', 'diag'].every((n) => paths.some((p) => p.endsWith(`/${n}`))));
// ⚠️ 2026-09-16 修正断言：prefix 注册**不能带尾斜杠**。
//   webServer 的 match() 是 `pathname.startsWith(prefix + '/')`（自己补斜杠），
//   若注册成 '/fairy-theme/asset/' 就会要求双斜杠 ⇒ 静态资源永久 404。
//   症状：exact 路由全 200，只有素材取不到，浮动形象渲染成破图。
//   所以这条断言要**确认它不带尾斜杠**，而不是像旧版那样要求带。
check('含 prefix 素材路由（且不带尾斜杠）',
  paths.some((p) => p === 'prefix:/fairy-theme/asset'),
  paths.join(' | '));
check('prefix 素材路由未误带尾斜杠（否则资源必 404）',
  !paths.some((p) => p.startsWith('prefix:/fairy-theme/asset/')),
  paths.join(' | '));

// ---------------------------------------------------------------- 3. 客户端语法

console.log('\n— 客户端 client.js');
const clientPath = path.join(ROOT, 'lib', 'client.js');
const clientSrc = fs.readFileSync(clientPath, 'utf8');

let syntaxError = null;
try { new vm.Script(clientSrc, { filename: 'client.js' }); } catch (e) { syntaxError = e; }
check('语法合法（可被 vm 解析）', syntaxError === null, syntaxError?.message?.split('\n')[0]);

check('未使用 TS 语法（无 `: string` 注解）', !/\)\s*:\s*(string|number|boolean)\s*\{/.test(clientSrc));
check('未使用 require 之外的 ESM import', !/^\s*import\s/m.test(clientSrc));

// ---------------------------------------------------------------- 4. 客户端行为

console.log('\n— 客户端 apply(ctx) 行为');
const loaded = [];
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
  URL,
  Math, Date, JSON, Promise, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set, WeakMap, Symbol,
};
sandbox.globalThis = sandbox;
sandbox.window = {
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  AudioContext: function AudioContext() {
    this.state = 'running';
    this.createGain = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
    this.createBufferSource = () => ({ buffer: null, connect() {}, start() {}, stop() {}, onended: null });
    this.decodeAudioData = async () => ({ duration: 1 });
    this.resume = async () => {};
    this.close = async () => {};
    this.addEventListener = () => {};
  },
  __ModuleLoader__: { load(mod) { loaded.push(mod); } },
};

const styleNodes = new Map();
sandbox.document = {
  head: { appendChild(n) { if (n.id) styleNodes.set(n.id, n); } },
  getElementById: (id) => styleNodes.get(id) ?? null,
  createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(), id: '', textContent: '',
      setAttribute(k, v) { this[k] = v; },
      remove() { if (this.id) styleNodes.delete(this.id); },
      children: [], appendChild() {},
    };
  },
  addEventListener() {}, removeEventListener() {},
};

const fakeReact = {
  createElement: (t, p, ...c) => ({ t, p, c }),
  useReducer: (init) => [typeof init === 'function' ? init(0) : init, () => {}],
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
};
const jsxRuntime = {
  jsx: (t, p) => ({ t, p }),
  jsxs: (t, p) => ({ t, p }),
  Fragment: 'Fragment',
};
const fakeRequire = (id) => {
  if (id === 'react') return fakeReact;
  if (id === 'react/jsx-runtime') return jsxRuntime;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Tooltip: (p) => p?.children ?? null };
  throw new Error(`未预期的 require: ${id}`);
};

const context = vm.createContext(sandbox);
let clientThrew = null;
try {
  vm.runInContext(clientSrc, context, { filename: 'client.js' });
} catch (e) { clientThrew = e; }
check('client.js 在沙箱中执行成功', clientThrew === null, clientThrew?.message);

check('注册到 __ModuleLoader__', loaded.length === 1, `id=${loaded[0]?.id}`);
check('模块 id 正确', loaded[0]?.id === 'dsh-fairy-theme', loaded[0]?.id);

let factoryOut = null, factoryErr = null;
try { factoryOut = loaded[0].factory(fakeRequire); } catch (e) { factoryErr = e; }
check('factory 执行成功', factoryErr === null, factoryErr?.message);
check('factory 返回 apply', typeof factoryOut?.apply === 'function');
// ⚠️ 2026-09-16 两度更正，最终定论：**必须**声明 inject: ['slots']。
//   第一版断言「有 inject」（对，但没写为什么）；
//   第二版我为规避 pending 改成断言「没有 inject」——**这是错的**，
//   代价是 ctx.slots 变成 undefined，浮动形象与设置面板静默失效，
//   而主题照旧生效 ⇒ 症状是「半生效」，极难定位（实测第三次重启即如此）。
//   实测反证：asar 内 31 个官方客户端插件全部声明 inject 含 "slots" 且都正常。
check("factory 声明 inject: ['slots']（ctx.slots 靠它挂载，缺则插槽静默失效）",
  Array.isArray(factoryOut?.inject) && factoryOut.inject.includes('slots'),
  JSON.stringify(factoryOut?.inject));

// mock cordis client ctx
const slotRegs = [];
const clientDisposers = [];
const clientCtx = {
  slots: {
    inject(name, provider) {
      slotRegs.push({ name, provider });
      return () => {};
    },
    register(def, comp) {
      slotRegs[slotRegs.length - 1].def = def;
      slotRegs[slotRegs.length - 1].comp = comp;
      const d = () => {};
      clientDisposers.push(d);
      return d;
    },
  },
  inject(deps, fn) { /* 检测器依赖宿主服务；沙箱里不提供，走 mark 分支 */ },
  effect(fn) { const d = fn(); if (typeof d === 'function') clientDisposers.push(d); return d; },
};

let applyThrew = null;
try { factoryOut.apply(clientCtx); } catch (e) { applyThrew = e; }
check('apply(ctx) 不抛异常', applyThrew === null, applyThrew?.message);

check('注入了 2 个 slot', slotRegs.length === 2, slotRegs.map((s) => s.name).join(', '));
check('含 shell.overlay', slotRegs.some((s) => s.name === 'shell.overlay'));
check('含 settings.section', slotRegs.some((s) => s.name === 'settings.section'));

// ================================================================
// 抗崩溃测试 —— 回答用户的直接提问：「插件出错会不会导致 DSH 打不开？」
//
// 依据 assertEntriesActive()：apply() 抛错 ⇒ entry 非 active ⇒
// page.fail() 接管整个界面 ⇒ **DSH 打不开**。
// 所以 apply() 必须在**任何**残缺环境下都只降级、不抛错。
// 下面逐条模拟真实会遇到的坏环境。
// ================================================================
console.log('\n--- 抗崩溃：残缺环境下 apply() 不得抛错 ---');
const brokenCtx = [
  ['ctx 完全为空 {}', {}],
  ['ctx 为 null', null],
  ['没有 slots 服务', { effect: (f) => f() }],
  ['slots.inject 抛错', { slots: { inject() { throw new Error('slots 炸了'); }, register() { throw new Error('炸'); } }, effect: (f) => f() }],
  ['slots.register 抛错', { slots: { inject: (n, p) => { p(); return () => {}; }, register() { throw new Error('register 炸了'); } }, effect: (f) => f() }],
  ['ctx.inject 抛错', { inject() { throw new Error('inject 炸了'); } }],
  ['ctx.effect 抛错', { slots: { inject: () => () => {}, register: () => () => {} }, effect() { throw new Error('effect 炸了'); } }],
  ['slots 是坏对象（inject 非函数）', { slots: { inject: 123 }, effect: (f) => f() }],
  ['ctx.inject 回调立即抛错', { inject: (deps, fn) => { fn({ slots: { inject() { throw new Error('回调里炸'); }, register() { throw new Error('炸'); } } }); } }],
];
let crashFail = 0;
for (const [label, bad] of brokenCtx) {
  let err = null;
  try { factoryOut.apply(bad); } catch (e) { err = e; }
  if (err) { crashFail++; console.log(`  [FAIL] ${label} → 抛错：${err.message}`); }
  else console.log(`  [PASS] ${label} → 未抛错`);
}
check(`★ apply() 在 ${brokenCtx.length} 种残缺环境下均不抛错（抛错会让 DSH 变失败页）`, crashFail === 0, `失败 ${crashFail} 项`);

// factory 在平台模块缺失时也不得抛错（缺 react ⇒ "import failed" ⇒ 同样整页失败）
{
  let err = null, out = null;
  try { out = loaded[0].factory(() => { throw new Error('模块不存在'); }); } catch (e) { err = e; }
  check('★ 平台模块全缺失时 factory 不抛错（降级为纯主题）', err === null,
    err ? `抛错：${err.message}` : `返回 apply=${typeof out?.apply}`);
}

const themeStyle = styleNodes.get('dsh-fairy-theme-style');
check('主题 style 节点已注入', Boolean(themeStyle));
const css = themeStyle?.textContent ?? '';
check('CSS 覆盖 body（浅色）', /body\{[^}]*--dsw-alias-brand-primary/.test(css));
check('CSS 覆盖 body[data-ds-dark-theme]（深色）', /body\[data-ds-dark-theme\]\{[^}]*--dsw-alias-brand-primary/.test(css));
check('CSS 含 HDD 主色 #2a3fec', css.includes('#2a3fec'));
check('CSS 含浮动 Fairy 定位规则', css.includes(`#dsh-fairy-theme-floating{position:fixed`));
check('CSS 无非官方选择器污染（只碰 body 与自家 id/class）',
  !/body\s*\[data-ds-/.test(css.replace(/body\[data-ds-dark-theme\]/g, '')));

// 覆盖的变量名必须是官方真实存在的。
// ⚠️ 2026-09-16 修正：原先这里硬编码了一份 13 个变量的白名单，
// 主题扩容到 60+ 变量后它立刻误报 FAIL —— 白名单会**随主题一起腐化**。
// 改为动态读取真实的官方主题包（asar 内），权威且永不腐化；
// asar 不可读时退回内置全集快照（由 .fairy/alias-table.json 生成）。
let official = null;
try {
  official = new Set(loadOfficialVars());
} catch {
  official = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'official-vars.json'), 'utf8')));
}
const overridden = [...css.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
const unknown = [...new Set(overridden)].filter((v) => !official.has(v));
check(`覆盖的 --dsw-* 全部是官方存在的变量（官方表 ${official.size} 个）`, unknown.length === 0,
  unknown.join(', ') || `检查了 ${new Set(overridden).size} 个变量，全部存在`);

// 覆盖率断言：覆盖得太少 = 「插件跑着但界面看不出变化」（2026-09-16 实测根因）
const myVars = [...new Set(overridden)];
check(`主题覆盖变量数 ≥ 40（当前 ${myVars.length}）—— 只覆盖强调色不足以改变观感`, myVars.length >= 40);

/** 按平台推导官方 app.asar 的常见位置。找不到就返回 null（调用方会回退到离线快照）。 */
function defaultAsarPath() {
  const p = process.platform;
  const candidates = [];
  if (p === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(local, 'Programs', 'DSH Desktop', 'resources', 'app.asar'),
      path.join(process.env.ProgramFiles || '', 'DSH Desktop', 'resources', 'app.asar'),
    );
  } else if (p === 'darwin') {
    candidates.push('/Applications/DSH Desktop.app/Contents/Resources/app.asar');
  } else {
    candidates.push('/opt/DSH Desktop/resources/app.asar', '/usr/lib/dsh-desktop/resources/app.asar');
  }
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

/** 从 app.asar 里的官方主题包抽取所有 --dsw-* 变量名（权威数据源）。
 *
 *  asar 路径按平台/安装方式推导，可用 DSH_ASAR 覆盖。
 *  ⚠️ 这份变量表也随包分发在 test/official-vars.json，所以找不到 asar 时
 *     只用离线副本即可，不判失败 —— 新克隆的仓库里不会有 app.asar。 */
function loadOfficialVars() {
  const ASAR = process.env.DSH_ASAR || defaultAsarPath();
  if (!ASAR || !fs.existsSync(ASAR)) {
    throw new Error(`未找到 app.asar（${ASAR || '路径未推导出'}）—— 设置 DSH_ASAR 指向它`);
  }
  // 必须置 true：否则 fs 会把 .asar 当目录包解析而读不到裸文件
  process.noAsar = true;
  const fd = fs.openSync(ASAR, 'r');
  const b16 = Buffer.alloc(16);
  fs.readSync(fd, b16, 0, 16, 0);
  const jsonSize = b16.readUInt32LE(12);
  const total = 16 + jsonSize;
  const hb = Buffer.alloc(total);
  fs.readSync(fd, hb, 0, total, 0);
  fs.closeSync(fd);
  let hjson = hb.subarray(16, total).toString('utf8');
  if (hjson.endsWith('\0')) hjson = hjson.slice(0, -1);
  const BASE = 16 + jsonSize;
  const buf = fs.readFileSync(ASAR);
  const hdr = JSON.parse(hjson);
  let node = hdr;
  for (const seg of '/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'.split('/').filter(Boolean)) {
    node = node?.files?.[seg];
    if (!node) throw new Error('asar 内找不到官方主题 client.js');
  }
  const txt = buf.slice(BASE + Number(node.offset), BASE + Number(node.offset) + node.size).toString('utf8');
  const set = new Set();
  for (const m of txt.matchAll(/(--dsw-[A-Za-z0-9-]+)\s*:/g)) set.add(m[1]);
  if (set.size < 100) throw new Error(`官方变量表异常小（${set.size}）`);
  return set;
}

console.log(`\n=== 结果：${results.filter((r) => r.ok).length}/${results.length} PASS，${failures} FAIL ===`);
process.exit(failures === 0 ? 0 : 1);
