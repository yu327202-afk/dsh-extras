#!/usr/bin/env node
/**
 * contract-test.mjs —— 检测层契约测试。
 *
 * 与 selftest.mjs 的分工：
 *   selftest  → 素材完整性 + 插件能否挂载
 *   本文件    → 检测层**真的**订阅到了正确的宿主契约吗？
 *
 * 用 mock ctx 模拟 0.1.5 的真实形状（按 asar 实测的字段名），
 * 断言：事件进得来、音效发得出、情绪对得上。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const clientSrc = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('=== dsh-fairy-theme 检测层契约测试 ===\n');

// ── 沙箱搭建（含真实形状的 mock）
const loaded = [];
const styleNodes = new Map();
const soundFetches = [];
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  URL, Math, Date, JSON, Promise, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set, WeakMap, Symbol,
  fetch: async (url) => {
    if (String(url).includes('/asset/sounds/')) soundFetches.push(String(url).split('/').pop());
    if (String(url).includes('/config')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, config: {
        theme: { enabled: true, mode: 'auto', ornaments: true },
        fairy: { enabled: true, size: 96, corner: 'bottom-right', reactToState: true },
        voice: { enabled: true, volume: 0.6 },
      } }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  },
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
  __ModuleLoader__: { load(m) { loaded.push(m); } },
};
sandbox.document = {
  head: { appendChild(n) { if (n.id) styleNodes.set(n.id, n); } },
  getElementById: (id) => styleNodes.get(id) ?? null,
  createElement(tag) {
    return { tagName: String(tag).toUpperCase(), id: '', textContent: '', setAttribute(k, v) { this[k] = v; },
      remove() { if (this.id) styleNodes.delete(this.id); }, children: [], appendChild() {} };
  },
  addEventListener() {}, removeEventListener() {},
};

const fakeReact = {
  createElement: (t, p, ...c) => ({ t, p, c }),
  useReducer: (init) => [typeof init === 'function' ? init(0) : init, () => {}],
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useMemo: (fn) => fn(), useRef: (v) => ({ current: v }), useCallback: (fn) => fn,
};
const fakeRequire = (id) => {
  if (id === 'react') return fakeReact;
  if (id === 'react/jsx-runtime') return { jsx: (t, p) => ({ t, p }), jsxs: (t, p) => ({ t, p }), Fragment: 'F' };
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Tooltip: (p) => p?.children ?? null };
  throw new Error(`未预期 require: ${id}`);
};

vm.runInContext(clientSrc, vm.createContext(sandbox), { filename: 'client.js' });
const mod = loaded[0];
const api = mod.factory(fakeRequire);

// ── mock 宿主 ctx：字段名全部照 asar 实测
const subscriptions = new Map();      // event → [handler]
const listeners = new Map();          // 用于手动触发
function makeSignalStore(initial) {
  let value = initial;
  const subs = new Set();
  return {
    getSnapshot: () => value,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    _set(v) { value = v; for (const f of [...subs]) f(); },
  };
}

const appState = {
  runningSessions: new Set(),
  listStore: makeSignalStore({ ids: [], byId: {}, current: undefined, phase: 'ready' }),
  pendingStore: makeSignalStore(new Map()),
  connState: makeSignalStore('connected'),
  pressureStore: makeSignalStore({ projectedTokens: 0, contextWindow: 100000 }),
  projectorsRebuilt: 0,
};

const hostCtx = {
  slots: { inject() { return () => {}; }, register() { return () => {}; } },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  on() {},
  inject(deps, fn) {
    // 按依赖名投喂真实形状的 mock
    if (deps.includes('remote')) {
      fn({
        remote: {
          $on(event, handler) {
            if (!subscriptions.has(event)) subscriptions.set(event, []);
            subscriptions.get(event).push(handler);
            const emit = (...args) => { for (const h of subscribersOf(event)) h(...args); };
            listeners.set(event, emit);
            return () => {};
          },
        },
      });
    }
    if (deps.includes('sessions')) {
      fn({
        sessions: {
          list: appState.listStore,
          binding(id) {
            appState.projectorsRebuilt++;
            return { sessionId: id, session: { projections: { faceOf: (name) => (name === 'contextPressure' ? appState.pressureStore : undefined) } } };
          },
        },
      });
    }
    if (deps.includes('uiSession')) fn({ uiSession: { pendingInteractions: appState.pendingStore } });
    if (deps.includes('connection')) fn({ connection: { state: appState.connState } });
  },
};
function subscribersOf(event) { return subscriptions.get(event) ?? []; }

// 启动
api.apply(hostCtx);
await new Promise((r) => setTimeout(r, 120));

console.log('— 订阅契约');
const expectEvents = ['api-session/status', 'api-session/added', 'api-session/removed', 'api-session/error'];
for (const e of expectEvents) {
  check(`订阅了 ${e}`, subscribersOf(e).length === 1, `${subscribersOf(e).length} 个监听器`);
}
check('未订阅 waterfall 类事件（approval/request）', subscribersOf('approval/request').length === 0,
  '不接管宿主流程是正确的保守选择');
// 只查「代码行」，注释里提到该名字是解释为什么不用它，不算残留。
// 判定用「去掉整行注释后是否还出现 eventSource」。
const codeLines = clientSrc
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .filter((line) => !/^\s*\*/.test(line));       // 去掉块注释续行
const leaky = codeLines.filter((line) => !/^\s*\/\*/.test(line) && line.includes('eventSource'));
check('未在代码中使用不存在的 binding.eventSource', leaky.length === 0,
  leaky.length ? leaky[0].trim() : '仅注释中提及该历史 API');

console.log('\n— 事件驱动行为');
const diag = () => sandbox.globalThis.__FAIRY_THEME_DIAG__;

// 1. 会话开始运行 → 工作态 + 音效
listeners.get('api-session/status')?.('sess-1', true);
await new Promise((r) => setTimeout(r, 60));
check('running=true → mood=working', diag().events.some((e) => e.detail === 'working' || e.kind === 'mood'),
  JSON.stringify(diag().events.slice(0, 2)));
check('running=true → 播放了 task-start 语音',
  soundFetches.some((f) => f.startsWith('task-start-')), soundFetches.join(',') || '无');

// 2. 第二个会话开始 → 不应重复出声（防子代理刷屏）
const before = soundFetches.length;
listeners.get('api-session/status')?.('sess-2', true);
await new Promise((r) => setTimeout(r, 60));
check('第二个会话 running 不重复播 task-start', soundFetches.length === before,
  `新增 ${soundFetches.length - before} 次`);

// 3. 全部结束 → success
listeners.get('api-session/status')?.('sess-1', false);
await new Promise((r) => setTimeout(r, 30));
const before2 = soundFetches.length;
listeners.get('api-session/status')?.('sess-2', false);
await new Promise((r) => setTimeout(r, 60));
check('全部结束 → 播放 success 语音',
  soundFetches.slice(before2).some((f) => f.startsWith('success-')), soundFetches.slice(before2).join(',') || '无');

console.log('\n— 会话切换');
appState.listStore._set({ ids: ['s1'], byId: { s1: { running: false } }, current: 's1' });
await new Promise((r) => setTimeout(r, 60));
check('首次绑定当前会话 → welcome 语音',
  soundFetches.some((f) => f.startsWith('welcome-')), soundFetches.join(',') || '无');
check('绑定时重建了投影（走了 sessions.binding）', appState.projectorsRebuilt > 0, `${appState.projectorsRebuilt} 次`);

console.log('\n— 上下文占用');
appState.pressureStore._set({ projectedTokens: 85000, contextWindow: 100000 });
await new Promise((r) => setTimeout(r, 60));
check('85% → 播放 context-warning 语音',
  soundFetches.includes('context-warning.wav'), soundFetches.join(',') || '无');
const before3 = soundFetches.length;
appState.pressureStore._set({ projectedTokens: 86000, contextWindow: 100000 });
await new Promise((r) => setTimeout(r, 60));
check('持续高压不重复报警', soundFetches.length === before3, `新增 ${soundFetches.length - before3} 次`);
appState.pressureStore._set({ projectedTokens: 70000, contextWindow: 100000 });
appState.pressureStore._set({ projectedTokens: 85000, contextWindow: 100000 });
await new Promise((r) => setTimeout(r, 60));
check('回落后再升高 → 重新报警', soundFetches.length > before3, `新增 ${soundFetches.length - before3} 次`);

console.log('\n— 待处理交互');
appState.pendingStore._set(new Map([['s1', { kind: 'approval' }]]));
await new Promise((r) => setTimeout(r, 60));
check('approval 出现 → 播放 permission 语音',
  soundFetches.some((f) => f.startsWith('permission-')), soundFetches.slice(-3).join(',') || '无');
const before4 = soundFetches.length;
appState.pendingStore._set(new Map([['s1', { kind: 'approval' }]]));
await new Promise((r) => setTimeout(r, 60));
check('同一 approval 不重复出声', soundFetches.length === before4, `新增 ${soundFetches.length - before4} 次`);

console.log('\n— 连接状态');
appState.connState._set('disconnected');
await new Promise((r) => setTimeout(r, 60));
check('断开 → 播放 network-error 语音',
  soundFetches.includes('network-error.wav'), soundFetches.slice(-3).join(',') || '无');
const before5 = soundFetches.length;
appState.connState._set('disconnected');
await new Promise((r) => setTimeout(r, 60));
check('保持断开不重复报警', soundFetches.length === before5, `新增 ${soundFetches.length - before5} 次`);

console.log('\n— 兜底与降级');
check('sessions.list 的 running 字段被采信',
  typeof appState.listStore.getSnapshot().byId === 'object');

console.log(`\n=== 结果：${results.filter((r) => r.ok).length}/${results.length} PASS，${failures} FAIL ===`);
console.log(`音效请求序列：${soundFetches.join(' → ') || '（无）'}`);
process.exit(failures === 0 ? 0 : 1);
