/**
 * dsh-fairy-theme — 客户端。
 *
 * 三件事，全部**不依赖 DOM 选择器**：
 *
 *   1. 主题：覆盖官方 --dsw-alias-* CSS 变量（定义在 body / body[data-ds-dark-theme]）。
 *      官方主题包 dsh-client-ui-theme 是**唯一**的变量来源，我们只在其后追加一层
 *      同优先级覆盖，因此不需要 :root、不抓任何元素、换版式不碎。
 *
 *   2. 浮动 Fairy：挂在官方 shell.overlay 插槽上，用 React 渲染。
 *      表情/动效由**真实 agent 事件**驱动（turn/start、turn/end、compaction/*、
 *      approval、contextPressure），不是随机动画。
 *
 *   3. 事件音效：44 段预置 WAV，从本机 /fairy-theme/asset/ 拉取，无外联。
 *
 * 已知失效模式：若 DSH 大版本改了变量名或 slot 名，表现是「某个特效不生效」，
 * 插件本身不崩（每个订阅各自 try/catch）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-fairy-theme',
  factory: (require) => {
    // 标准 CJS 样板。官方与所有能工作的三方 bundle 都有这两行，
    // 加载器最终通过 factory 的**返回值**取 exports（dsh-client-modules 的
    // materialize 实现为 `exports: registered(factory(require))`），
    // 显式声明 module.exports 是为了与生态一致、也便于将来 bundle 化。
    var module = { exports: {} };
    var exports = module.exports;

    // ★★★ factory 顶层同样**不允许抛错**。★★★
    // factory 抛错 ⇒ fiber === undefined ⇒ assertEntriesActive() 报
    // "import failed" ⇒ page.fail() 接管整个界面。
    // 平台种子模块（react / react/jsx-runtime / ui-primitives）正常都在，
    // 但**万一不在**，也必须是「功能降级」而不是「DSH 打不开」。
    const platform = (name, fallback) => {
      try { return require(name); } catch { return fallback; }
    };
    const React = platform('react', null);
    const jsx = platform('react/jsx-runtime', null);
    const primitives = platform('@deepseek-ai/dsh-client-ui-primitives', null);
    const Tooltip = primitives?.Tooltip || (({ children }) => children);

    // 缺 jsx 运行时就没有 UI 可言 —— 但不抛错，只关掉所有需要 UI 的部分。
    const HAS_UI = Boolean(React && jsx);
    const Noop = () => null;

    const ROUTE = '/fairy-theme';
    const STYLE_ID = 'dsh-fairy-theme-style';
    const FLOATING_ID = 'dsh-fairy-theme-floating';

    // ================================================================ 诊断

    const diagnostics = {
      mounted: false,
      themeApplied: false,
      fairyMounted: false,
      audioContextState: 'none',
      subscriptions: Object.create(null),
      events: [],
      notes: [],
    };

    function note(message) {
      diagnostics.notes.push({ at: Date.now(), message: String(message) });
      if (diagnostics.notes.length > 40) diagnostics.notes.splice(0, diagnostics.notes.length - 40);
      try { console.warn(`[fairy-theme] ${message}`); } catch { /* 无所谓 */ }
    }

    function mark(name, value) {
      diagnostics.subscriptions[name] = value;
    }

    function recordEvent(kind, detail) {
      diagnostics.events.unshift({ at: Date.now(), kind, detail: detail ?? null });
      if (diagnostics.events.length > 20) diagnostics.events.length = 20;
      try { globalThis.__FAIRY_THEME_DIAG__ = diagnostics; } catch { /* 无所谓 */ }
    }

    // ================================================================ 共享状态

    const listeners = new Set();
    const store = {
      ready: false,
      error: null,
      config: null,
      revision: 0,
      /** 浮动 Fairy 的实时状态：idle | working | success | error | waiting | alert | celebrating */
      mood: 'idle',
      /** 当前上下文占用百分比（0-100），未知为 null */
      pressurePercent: null,
    };

    function publish() {
      store.revision += 1;
      for (const listener of [...listeners]) {
        try { listener(); } catch { /* 视图报错不影响引擎 */ }
      }
    }

    function subscribeStore(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function setMood(next, detail) {
      if (!next || store.mood === next) return;
      store.mood = next;
      recordEvent('mood', next);
      publish();
    }

    // ================================================================ 主题

    /*
     * 配色取自 FairyAvatar（NPC-Fairy-New-4096）与动画帧的实际取色：
     *   外环蓝 #2a3fec / #2c41ed      瞳孔深蓝 #262b86 / #293289
     *   内环灰白 #d7d4dc              过渡蓝 #808dc5 / #2e63c1
     *   高光白 #ededed
     *
     * 只覆盖「带色彩的语义变量」，中性的层级/边框/文字一律继承官方，
     * 这样明暗两套都不会因为我们的色值而失去对比度。
     */

    const ACCENT = {
      ring: '#2a3fec',
      ringSoft: '#2c41ed',
      iris: '#2e63c1',
      pupil: '#262b86',
      pupilDeep: '#1b1f66',
      halo: '#808dc5',
      shell: '#d7d4dc',
      glow: '#ededed',
    };

    /*
     * ⚠️ 覆盖范围是**见过的最大坑**（2026-09-16 实测）：
     * 只改 `--dsw-alias-brand-*` 这类**强调色**不会让界面看起来有任何变化 ——
     * 官方 79 个 alias 变量的被引用次数极度不均（数据见 `.fairy/alias-table.json`）：
     *   label-tertiary 197×、label-primary 191×、label-secondary 144×、
     *   interactive-bg-hover 89×、label-caption 73×、
     *   border-l2 47×/l4 37×/l1 32×/l3 30×、bg-layer-1 36×、bg-base 22× …
     * 而 `brand-primary-new-color` 只有 7×。
     * ⇒ 必须覆盖**高频中性色与背景层**，否则「插件跑得好好的，界面纹丝不动」。
     *
     * 配色原则「取其形、去其毒」：
     *   - 深色底走**深蓝黑**（不用纯黑，纯黑长时间看会"吸光"）
     *   - 浅色底走**极浅蓝白**（不用纯白，纯白正文长读刺眼）
     *   - 中性文字色**带一点蓝调** —— 这是让整体观感「是 Fairy」而非
     *     「某个按钮换了个蓝色」的关键
     */

    /*
     * 品牌色阶（**原语层**）。
     *
     * 为什么必须连原语一起覆盖：界面里有若干处**绕过 alias 直接引用原语**，
     * 最典型的是发送按钮（官方 `--dsw-static-deepseek-500` = `#4176e6`）。
     * 只改 alias 时，这些地方纹丝不动 —— 实测两次重启的截图里，
     * 全图唯一的鲜艳蓝正是发送按钮的 `#4176e6`。
     *
     * 覆盖原语是「一次覆盖、处处生效」的做法：所有由它派生的 alias
     * （button-info-fill、link、state-business-primary…）都会跟着变。
     * 这几项在官方里明暗同值，故两套配色共用。
     */
    const BRAND_RAMP = {
      '--dsw-static-deepseek-50': '#eef1ff',
      '--dsw-static-deepseek-100': '#e2e7ff',
      '--dsw-static-deepseek-200': '#c9d1ff',
      '--dsw-static-deepseek-300': '#a9b5ff',
      '--dsw-static-deepseek-400': '#7b8bff',
      '--dsw-static-deepseek-450': '#6675ff',
      '--dsw-static-deepseek-500': '#4a5cff',
      '--dsw-static-deepseek-600': '#3a49cc',
      '--dsw-static-deepseek-800': '#2a2f66',
      '--dsw-static-deepseek-900': '#1c2047',
    };

    /** 深色模式：深蓝黑底 + 蓝调白字。 */
    const DARK_VARS = {
      // 自有变量，供 ORNAMENT_CSS 与浮动组件复用
      '--fairy-accent': ACCENT.ring,
      '--fairy-accent-soft': ACCENT.ringSoft,
      '--fairy-iris': ACCENT.iris,
      '--fairy-pupil': ACCENT.pupil,
      '--fairy-halo': ACCENT.halo,

      // 背景层：越靠上层越亮，形成层级感
      '--dsw-alias-bg-base': '#0b0e22',
      '--dsw-alias-bg-layer-1': '#10142c',
      '--dsw-alias-bg-layer-2': '#151a38',
      '--dsw-alias-bg-layer-3': '#1a2044',
      '--dsw-alias-bg-module-platform': '#131735',
      '--dsw-alias-bg-overlay': '#0d1026',
      '--dsw-alias-bg-multi-select': '#182046',
      '--dsw-alias-bg-skeleton': '#8fa3ff14',
      '--dsw-alias-bg-mask-drop': '#07091abf',

      // 文字：蓝调白（#e9ecff 而非 #ffffff）
      '--dsw-alias-label-primary': '#e9ecff',
      '--dsw-alias-label-primary-dimmed': '#c8cef2',
      '--dsw-alias-label-primary-foreground': '#0b0e22',
      '--dsw-alias-label-primary-inverted': '#0b0e22',
      '--dsw-alias-label-secondary': '#c2c9ee',
      '--dsw-alias-label-tertiary': '#98a1d0',
      '--dsw-alias-label-caption': '#7c85b6',
      '--dsw-alias-label-dimmed': '#616a99',
      '--dsw-alias-label-primary-bluish': '#b9c4ff',

      // 边框：蓝调描边，比官方中性灰更"通透"
      '--dsw-alias-border-l1': '#8fa3ff1a',
      '--dsw-alias-border-l2': '#8fa3ff29',
      '--dsw-alias-border-l3': '#8fa3ff38',
      '--dsw-alias-border-l4': '#8fa3ff4d',
      '--dsw-alias-border-l2-darkmode-thin': '#8fa3ff1f',

      // 交互态叠加：蓝调而非中性
      '--dsw-alias-interactive-bg-hover': '#7b93ff1f',
      '--dsw-alias-interactive-bg-active': '#7b93ff2e',
      '--dsw-alias-interactive-bg-hover-solid': '#1c2350',
      '--dsw-alias-interactive-bg-hover-accent': '#7b93ff3d',
      '--dsw-alias-interactive-bg-hover-danger': '#f25a5a26',

      // 滚动条
      '--dsw-alias-scrollbar-bg-l1': '#2a3468',
      '--dsw-alias-scrollbar-bg-l2': '#323d7a',
      '--dsw-alias-scrollbar-hover-l1': '#3b4788',
      '--dsw-alias-scrollbar-hover-l2': '#465396',

      // 品牌 / 按钮（深色下提亮，保证对比度）
      '--dsw-alias-brand-primary': '#5566ff',
      '--dsw-alias-brand-primary-new-colorprimary-new-color': '#5566ff',
      // 语义色**保持官方红**：错误/危险提示必须一眼可辨，染成蓝色是可用性事故
      '--dsw-alias-state-error-primary': '#f25a5a',
      '--dsw-alias-state-error-secondary': '#f25a5a',
      '--dsw-alias-brand-primary-invert': '#0b0e22',
      '--dsw-alias-brand-text': '#eef1ff',
      '--dsw-alias-link': '#8ba3ff',
      '--dsw-alias-button-info-fill': '#4a5cff',
      '--dsw-alias-button-info-hover': '#5f70ff',
      '--dsw-alias-button-primary-fill': '#4a5cff',
      '--dsw-alias-button-primary-hover': '#5f70ff',
      '--dsw-alias-button-primary-dimmed': '#252b54',
      '--dsw-alias-button-elevated-fill': '#1a2044',
      '--dsw-alias-button-floating-fill': '#1a2044',
      '--dsw-alias-button-floating-hover': '#222a56',
      '--dsw-alias-state-business-primary': '#5566ff',
      '--dsw-alias-state-business-tertiary': '#1a1f52',

      // 代码块 / 浮层
      '--dsw-alias-markdown-code-block': '#0e1230',
      '--dsw-alias-markdown-code-block-banner': '#151a3c',
      '--dsw-alias-markdown-inline-code': '#181f45',
      '--dsw-alias-markdown-citation': '#1c2350',
      '--dsw-alias-markdown-tag': '#1c2350',
      '--dsw-alias-markdown-placeholder': '#151a38',
      '--dsw-alias-toast-bg': '#1a2044',
      '--dsw-alias-tooltip-bg': '#1f2650',
      ...BRAND_RAMP,
    };

    /** 浅色模式：极浅蓝白底 + 深蓝墨字。 */
    const LIGHT_VARS = {
      '--fairy-accent': ACCENT.ring,
      '--fairy-accent-soft': ACCENT.ringSoft,
      '--fairy-iris': ACCENT.iris,
      '--fairy-pupil': ACCENT.pupil,
      '--fairy-halo': ACCENT.halo,

      // 背景层：官方明色下三层同为纯白，这里给出细微蓝调层次
      '--dsw-alias-bg-base': '#f5f7ff',
      '--dsw-alias-bg-layer-1': '#fdfdff',
      '--dsw-alias-bg-layer-2': '#f8faff',
      '--dsw-alias-bg-layer-3': '#f0f4ff',
      '--dsw-alias-bg-module-platform': '#eef1fb',
      '--dsw-alias-bg-overlay': '#f2f4fd',
      '--dsw-alias-bg-multi-select': '#e8ecfa',
      '--dsw-alias-bg-skeleton': '#2a3fec0f',
      '--dsw-alias-bg-mask-drop': '#0a0c1f1f',

      // 文字：深蓝墨（#161a33 而非 #000000）
      '--dsw-alias-label-primary': '#161a33',
      '--dsw-alias-label-primary-dimmed': '#2c3357',
      '--dsw-alias-label-primary-foreground': '#fdfdff',
      '--dsw-alias-label-primary-inverted': '#fdfdff',
      '--dsw-alias-label-secondary': '#3b4368',
      '--dsw-alias-label-tertiary': '#646c95',
      '--dsw-alias-label-caption': '#868db2',
      '--dsw-alias-label-dimmed': '#a3a9c7',
      '--dsw-alias-label-primary-bluish': '#262b86',

      '--dsw-alias-border-l1': '#2a3fec14',
      '--dsw-alias-border-l2': '#2a3fec1f',
      '--dsw-alias-border-l3': '#2a3fec29',
      '--dsw-alias-border-l4': '#2a3fec38',
      '--dsw-alias-border-l2-darkmode-thin': '#2a3fec1a',

      '--dsw-alias-interactive-bg-hover': '#2a3fec12',
      '--dsw-alias-interactive-bg-active': '#2a3fec1f',
      '--dsw-alias-interactive-bg-hover-solid': '#e6eaff',
      '--dsw-alias-interactive-bg-hover-accent': '#2a3fec24',
      '--dsw-alias-interactive-bg-hover-danger': '#ec131312',

      '--dsw-alias-scrollbar-bg-l1': '#ccd3ef',
      '--dsw-alias-scrollbar-bg-l2': '#c3cbec',
      '--dsw-alias-scrollbar-hover-l1': '#adb7e4',
      '--dsw-alias-scrollbar-hover-l2': '#a3aee0',

      '--dsw-alias-brand-primary': '#262b86',
      '--dsw-alias-brand-primary-new-colorprimary-new-color': '#2a3fec',
      // 语义色保持官方红（同深色模式的理由）
      '--dsw-alias-state-error-primary': '#ec1313',
      '--dsw-alias-state-error-secondary': '#f25a5a',
      '--dsw-alias-brand-primary-invert': '#fdfdff',
      '--dsw-alias-brand-text': '#161a33',
      '--dsw-alias-link': '#2e63c1',
      '--dsw-alias-button-info-fill': '#2a3fec',
      '--dsw-alias-button-info-hover': '#2c41ed',
      '--dsw-alias-button-primary-fill': '#262b86',
      '--dsw-alias-button-primary-hover': '#1b1f66',
      '--dsw-alias-button-primary-dimmed': '#dfe3f8',
      '--dsw-alias-button-elevated-fill': '#fdfdff',
      '--dsw-alias-button-floating-fill': '#fdfdff',
      '--dsw-alias-button-floating-hover': '#eef1fb',
      '--dsw-alias-state-business-primary': '#2a3fec',
      '--dsw-alias-state-business-tertiary': '#e6e9ff',

      '--dsw-alias-markdown-code-block': '#f2f5ff',
      '--dsw-alias-markdown-code-block-banner': '#e9edfc',
      '--dsw-alias-markdown-inline-code': '#eef1fb',
      '--dsw-alias-markdown-citation': '#e8ecfa',
      '--dsw-alias-markdown-tag': '#e8ecfa',
      '--dsw-alias-markdown-placeholder': '#e4e9f9',
      '--dsw-alias-toast-bg': '#1b2046',
      '--dsw-alias-tooltip-bg': '#1b2046',
      ...BRAND_RAMP,
    };

    function varsToCss(selector, vars) {
      // 两道保险，确保**不依赖样式表插入顺序**（官方主题的 <style> 与我们的
      // 特异性相同，谁在文档后面谁生效，顺序不受我们控制）：
      //   1. 选择器加 `html ` 前缀抬高特异性（0,0,0,2 > 官方 body 的 0,0,0,1）
      //   2. 声明加 !important —— 自定义属性同样支持，直接压过同特异性的官方声明
      const body = Object.entries(vars).map(([k, v]) => `${k}:${v}!important`).join(';');
      return `html ${selector}{${body}}`;
    }

    /** HDD 风格的点缀：只加在 shell.overlay 自己的根上，不碰官方布局。 */
    const ORNAMENT_CSS = `
#${FLOATING_ID}{position:fixed;z-index:60;pointer-events:none;display:block;line-height:0}
#${FLOATING_ID}[data-corner="bottom-right"]{right:20px;bottom:20px}
#${FLOATING_ID}[data-corner="bottom-left"]{left:20px;bottom:20px}
#${FLOATING_ID}[data-corner="top-right"]{right:20px;top:64px}
#${FLOATING_ID}[data-corner="top-left"]{left:20px;top:64px}
.dsh-fairy-pet{pointer-events:auto;position:relative;display:grid;place-items:center;cursor:grab;
  filter:drop-shadow(0 6px 18px color-mix(in srgb,var(--fairy-accent,#2a3fec) 42%,transparent));
  transition:transform .28s cubic-bezier(.22,1,.36,1),filter .28s ease}
.dsh-fairy-pet:active{cursor:grabbing}
.dsh-fairy-pet[data-mood="working"]{animation:dsh-fairy-breathe 1.6s ease-in-out infinite}
.dsh-fairy-pet[data-mood="success"]{animation:dsh-fairy-pop .5s ease-out}
.dsh-fairy-pet[data-mood="error"]{animation:dsh-fairy-shake .45s ease-in-out}
.dsh-fairy-pet[data-mood="waiting"]{animation:dsh-fairy-pulse 1.1s ease-in-out infinite}
.dsh-fairy-pet[data-mood="alert"]{animation:dsh-fairy-flash .8s ease-in-out infinite}
.dsh-fairy-pet[data-mood="celebrating"]{animation:dsh-fairy-pop .6s ease-out 2}
.dsh-fairy-pet img,.dsh-fairy-pet svg{display:block;width:100%;height:100%;-webkit-user-drag:none;user-select:none}
.dsh-fairy-pet[data-static="true"]{animation:none}
.dsh-fairy-ring{position:absolute;inset:-6%;border-radius:999px;border:1px solid
  color-mix(in srgb,var(--fairy-accent,#2a3fec) 36%,transparent);opacity:0;transition:opacity .3s ease}
.dsh-fairy-pet[data-mood="waiting"] .dsh-fairy-ring{opacity:1}
.dsh-fairy-hud{position:absolute;left:50%;transform:translateX(-50%);bottom:-6px;white-space:nowrap;
  font-size:11px;line-height:1;padding:4px 8px;border-radius:999px;
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 82%,transparent);
  border:1px solid color-mix(in srgb,var(--fairy-accent,#2a3fec) 30%,transparent);
  color:var(--dsw-alias-label-secondary,#666);backdrop-filter:blur(6px);opacity:0;transition:opacity .25s ease}
.dsh-fairy-pet:hover .dsh-fairy-hud{opacity:1}
@keyframes dsh-fairy-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.045)}}
@keyframes dsh-fairy-pulse{0%,100%{transform:scale(1);filter:none}50%{transform:scale(1.07)}}
@keyframes dsh-fairy-pop{0%{transform:scale(1)}40%{transform:scale(1.16)}100%{transform:scale(1)}}
@keyframes dsh-fairy-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}80%{transform:translateX(2px)}}
@keyframes dsh-fairy-flash{0%,100%{filter:none}50%{filter:brightness(1.25) saturate(1.2)}}
@media (prefers-reduced-motion:reduce){
  .dsh-fairy-pet{animation:none !important;transition:none !important}
}
.dsh-fairy-opt-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0}
.dsh-fairy-opt-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a9099);margin-top:2px}
.dsh-fairy-opt-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.dsh-fairy-opt-actions button{padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:inherit;cursor:pointer;font-size:12px}
.dsh-fairy-opt-actions button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fairy-diag{display:flex;flex-direction:column;gap:2px;font-family:ui-monospace,Consolas,monospace;font-size:11px;
  color:var(--dsw-alias-label-tertiary,#8a9099);max-height:200px;overflow:auto;margin-top:6px}
`;

    /**
     * 主题样式节点。放在 <head> 末尾，官方主题包写入后加载的样式，
     * 同优先级下后出现者胜 —— 因此不需要 !important，也不会污染 :root。
     */
    function ensureThemeStyle() {
      let el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        el.setAttribute('data-plugin', 'dsh-fairy-theme');
        document.head.appendChild(el);
      }
      return el;
    }

    /** 上次写入的 CSS 签名，用于避免每次状态变化都重写样式节点。 */
    let appliedSignature = null;

    /**
     * 注入主题变量。
     *
     * mode 语义：
     *   auto  → 明暗各写各的（跟随系统/官方开关），只覆盖对应分支
     *   dark  → 把深色配色同时写到 body 与 body[data-ds-dark-theme]，
     *           强制深色（官方暗色块对 body[data-ds-dark-theme] 特异性更高，
     *           只写 body 是压不住的）
     *   light → 反过来强制浅色
     */
    function applyTheme(mode) {
      const el = ensureThemeStyle();
      let css;
      if (mode === 'dark') {
        const dark = varsToCss('body', DARK_VARS);
        const darkAttr = varsToCss('body[data-ds-dark-theme]', DARK_VARS);
        css = `${dark}\n${darkAttr}`;
      } else if (mode === 'light') {
        const light = varsToCss('body', LIGHT_VARS);
        const lightAttr = varsToCss('body[data-ds-dark-theme]', LIGHT_VARS);
        css = `${light}\n${lightAttr}`;
      } else {
        const dark = varsToCss('body[data-ds-dark-theme]', DARK_VARS);
        const light = varsToCss('body', LIGHT_VARS);
        css = `${dark}\n${light}`;
      }
      const full = `${css}\n${ORNAMENT_CSS}`;
      // 内容没变就不碰 DOM —— 重写会触发整页样式重算，白白浪费且可能闪一下。
      if (full !== appliedSignature) {
        el.textContent = full;
        appliedSignature = full;
      }
      diagnostics.themeApplied = true;
      return el;
    }

    function removeTheme() {
      document.getElementById(STYLE_ID)?.remove();
      appliedSignature = null;
      diagnostics.themeApplied = false;
    }

    // ================================================================ 音效

    const TRIGGER_SOUNDS = {
      welcome: ['welcome-1.wav', 'welcome-2.wav', 'welcome-3.wav', 'welcome-4.wav', 'welcome-5.wav', 'welcome-6.wav', 'welcome-7.wav'],
      goodbye: ['goodbye-1.wav', 'goodbye-2.wav', 'goodbye-3.wav', 'goodbye-4.wav', 'goodbye-5.wav', 'goodbye-6.wav'],
      'task-start': ['task-start-1.wav', 'task-start-2.wav', 'task-start-3.wav', 'task-start-4.wav'],
      success: ['success-1.wav', 'success-2.wav', 'success-3.wav'],
      error: ['error.wav'],
      'network-error': ['network-error.wav'],
      aborted: ['aborted.wav'],
      retry: ['retry.wav'],
      'new-session': ['new-session.wav'],
      'session-switch': ['session-switch.wav'],
      'model-switch': ['model-switch.wav'],
      permission: ['permission-1.wav', 'permission-2.wav', 'permission-3.wav'],
      'permission-approved': ['permission-approved.wav'],
      'permission-denied': ['permission-denied.wav'],
      'context-warning': ['context-warning.wav'],
      'quota-warning': ['quota-warning.wav'],
      'compact-auto': ['compact-auto.wav'],
      'compact-manual': ['compact-manual.wav'],
      'compact-success': ['compact-success.wav'],
      'compaction-failed': ['compaction-failed.wav'],
    };

    /** 优先级：高 > 中 > 低；高优先级可抢占低优先级。 */
    const PRIORITY = {
      'network-error': 3, error: 3, aborted: 3,
      permission: 2, 'permission-denied': 2, 'context-warning': 2, 'quota-warning': 2,
      'compaction-failed': 2,
      success: 1, 'task-start': 1, retry: 1, 'compact-success': 1,
      'compact-auto': 1, 'compact-manual': 1, 'model-switch': 1,
      welcome: 0, goodbye: 0, 'new-session': 0, 'session-switch': 0,
      'permission-approved': 1,
    };

    function createPlayer() {
      let context = null;
      let master = null;
      let current = null;          // 当前播放的 AudioBufferSource
      let currentPriority = -1;
      let lastFile = null;
      let unlocked = false;
      const bufferCache = new Map();

      function volume() {
        const v = Number(store.config?.voice?.volume);
        return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.6;
      }

      function ensureContext() {
        if (context) return context;
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) { note('浏览器没有 AudioContext，无法播放音效'); return null; }
        try {
          context = new Ctor();
          master = context.createGain();
          master.gain.value = volume();
          master.connect(context.destination);
          diagnostics.audioContextState = context.state;
          context.addEventListener?.('statechange', () => { diagnostics.audioContextState = context.state; });
        } catch (error) {
          note(`创建 AudioContext 失败：${error?.message || error}`);
          return null;
        }
        return context;
      }

      async function unlock() {
        if (unlocked) return;
        const c = ensureContext();
        if (!c) return;
        try {
          if (c.state === 'suspended') await c.resume();
          unlocked = c.state === 'running';
          diagnostics.audioContextState = c.state;
        } catch (error) {
          note(`解锁音频失败：${error?.message || error}`);
        }
      }

      async function load(file) {
        if (bufferCache.has(file)) return bufferCache.get(file);
        const c = ensureContext();
        if (!c) return null;
        const promise = (async () => {
          const res = await fetch(`${ROUTE}/asset/sounds/${file}`, { cache: 'force-cache' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bytes = await res.arrayBuffer();
          return await c.decodeAudioData(bytes);
        })();
        bufferCache.set(file, promise);
        try {
          return await promise;
        } catch (error) {
          bufferCache.delete(file);
          throw error;
        }
      }

      /** 播放一个触发器；返回是否真的播了。 */
      async function fire(id) {
        const cfg = store.config;
        if (!cfg?.voice?.enabled) return false;
        const list = TRIGGER_SOUNDS[id];
        if (!list?.length) return false;

        const priority = PRIORITY[id] ?? 0;
        if (current && priority < currentPriority) return false;   // 低优先级不打断高优先级

        // 同类随机不连播
        let file = list[Math.floor(Math.random() * list.length)];
        if (list.length > 1 && file === lastFile) {
          file = list[(list.indexOf(file) + 1) % list.length];
        }

        await unlock();
        let buffer;
        try {
          buffer = await load(file);
        } catch (error) {
          note(`音效加载失败 ${file}：${error?.message || error}`);
          return false;
        }
        if (!buffer) return false;

        try {
          if (current) { try { current.stop(); } catch { /* 已结束 */ } }
          const c = ensureContext();
          const src = c.createBufferSource();
          src.buffer = buffer;
          src.connect(master);
          src.onended = () => { if (current === src) { current = null; currentPriority = -1; } };
          src.start();
          current = src;
          currentPriority = priority;
          lastFile = file;
          recordEvent('sound', { id, file });
          return true;
        } catch (error) {
          note(`播放失败 ${file}：${error?.message || error}`);
          return false;
        }
      }

      function dispose() {
        try { current?.stop(); } catch { /* 忽略 */ }
        try { master?.disconnect(); } catch { /* 忽略 */ }
        try { context?.close(); } catch { /* 忽略 */ }
        current = null; master = null; context = null;
        bufferCache.clear();
      }

      return { fire, unlock, dispose, setVolume: () => { if (master) master.gain.value = volume(); } };
    }

    // ================================================================ 事件 → 状态 + 音效

    /**
     * 唯一把宿主事件翻译成「Fairy 的表情」和「音效」的地方。
     * 每个信号源独立 try/catch，单路失效不会让整个插件哑掉。
     *
     * ⚠️ 2026-09-15 实测修正：社区范本（dsh-fairy-voice 1.0.5）依赖的
     * `binding.eventSource` 在 core 0.1.5-rc.1 里**根本不存在**（asar 全量扫描 0 命中），
     * 因此拿不到 turn/start、turn/end、compaction/*、llm/retry 这类**会话日志事件**。
     * 本插件改用 0.1.5 里真正有契约保证的两条通路：
     *
     *   1. `ctx.remote.$on(<事件名>, listener)` —— 19 个合法键定义在
     *      dsh-api-remotes/lib/types/remote-events.js 的 API_REMOTE_FORWARDED_EVENTS，
     *      listener 实参形状由官方自己的消费点确定
     *      （如 api-session/status 官方写作 `(sessionId, running)`）。
     *   2. `binding.session.projections.faceOf(name).getSnapshot()` —— 会话投影面，
     *      官方 ui-goal 的用法为 `sessions.binding(id)?.session.projections.faceOf("goal")?.getSnapshot()`。
     *
     * 刻意**不**注册 waterfall 类事件（approval/request、user-questions/request）：
     * 那类监听器必须调用 next 才不会截断宿主流程，为放音效冒这个险不值得 ——
     * 权限提示改用 uiSession.pendingInteractions 的只读快照检测。
     */
    function createDetectors(ctx, player) {
      const disposers = [];
      let boundProjectionSessionId = null;
      let pressureDispose = null;
      let lastCurrentSession = null;
      let pressureArmed = true;
      /** 正在运行的会话集合：任一为真即视为「工作中」，天然覆盖子代理。 */
      const runningSessions = new Set();
      /** 已经报过的待处理交互（key = sessionId + kind），避免重复出声。 */
      const seenPending = new Set();

      function add(dispose) {
        if (typeof dispose === 'function') disposers.push(dispose);
      }

      function fire(id, detail) {
        const moodFor = {
          'task-start': 'working',
          success: 'success',
          error: 'error',
          'network-error': 'error',
          aborted: 'idle',
          retry: 'working',
          permission: 'waiting',
          'permission-approved': 'success',
          'permission-denied': 'error',
          'context-warning': 'alert',
          'quota-warning': 'alert',
          'compaction-failed': 'error',
          'compact-auto': 'working',
          'compact-manual': 'working',
          'compact-success': 'success',
          welcome: 'celebrating',
        };
        if (moodFor[id] && store.config?.fairy?.reactToState !== false) setMood(moodFor[id], id);
        void player.fire(id).catch((error) => note(`触发 ${id} 失败：${error?.message || error}`));
      }

      /** 会话投影面：绑定到当前会话，读上下文占用等。换会话时重建。 */
      function bindProjections(sessions, sessionId) {
        if (boundProjectionSessionId === sessionId) return;
        boundProjectionSessionId = sessionId;
        if (pressureDispose) { try { pressureDispose(); } catch { /* 忽略 */ } pressureDispose = null; }
        if (!sessionId) return;

        let binding;
        try {
          binding = sessions.binding?.(sessionId);
        } catch (error) {
          mark('会话投影面', `绑定失败：${error?.message || error}`);
          return;
        }
        const face = binding?.session?.projections?.faceOf?.('contextPressure');
        if (!face?.subscribe || !face?.getSnapshot) {
          mark('上下文占用', '该会话没有 contextPressure 投影');
          return;
        }

        pressureArmed = true;
        const read = () => {
          try {
            const p = face.getSnapshot();
            // 字段名取自官方 contextOccupancy()：projectedTokens（新）/ pressureTokens（旧）+ contextWindow
            const used = p?.projectedTokens ?? p?.pressureTokens;
            const total = p?.contextWindow;
            if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return;
            const ratio = used / total;
            store.pressurePercent = Math.min(100, Math.round(ratio * 100));
            if (ratio >= 0.8) {
              if (pressureArmed) { pressureArmed = false; fire('context-warning', { percent: store.pressurePercent }); }
            } else if (ratio < 0.75) {
              pressureArmed = true;   // 压缩后回落到阈值以下才重新武装
            }
            publish();
          } catch (error) {
            note(`读取上下文占用失败：${error?.message || error}`);
          }
        };
        pressureDispose = face.subscribe(read);
        read();
        mark('上下文占用', '已订阅');
      }

      function start() {
        // ---- ① remote 转发事件：运行状态 / 会话增删 / 错误
        //      这是 0.1.5 里唯一有契约保证的「宿主事件」通路。
        ctx.inject(['remote'], (rctx) => {
          const remote = rctx.remote;
          if (!remote?.$on) { mark('远端事件', '宿主没有 remote.$on'); return; }
          const on = (event, handler, label) => {
            try {
              const dispose = remote.$on(event, handler);
              add(typeof dispose === 'function' ? dispose : () => {});
              mark(label, '已订阅');
            } catch (error) {
              mark(label, `订阅失败：${error?.message || error}`);
            }
          };

          // 运行状态：官方签名 (sessionId, running) —— 直接驱动 working/idle 表情。
          on('api-session/status', (sessionId, running) => {
            const id = String(sessionId ?? '');
            if (running) {
              if (!runningSessions.has(id)) {
                runningSessions.add(id);
                // 只有首个开始运行的会话才出声，避免子代理批量唤醒时刷屏。
                if (runningSessions.size === 1) fire('task-start', { id: id.slice(0, 8) });
                else setMood('working', 'subagent-start');
              }
            } else {
              runningSessions.delete(id);
              if (runningSessions.size === 0) fire('success', { id: id.slice(0, 8) });
            }
          }, '运行状态');

          // 会话新增 / 移除
          on('api-session/added', () => fire('new-session', {}), '会话新增');
          on('api-session/removed', () => fire('goodbye', {}), '会话移除');

          // 会话级错误
          on('api-session/error', (sessionId, message) => {
            fire('error', { id: String(sessionId ?? '').slice(0, 8), message: String(message ?? '').slice(0, 120) });
          }, '会话错误');

          // 模型切换
          on('llm/adapters-updated', () => {}, '适配器变更');

          // 首帧基线：官方在 connection/reset 时要求各插件重置本地面
          try {
            ctx.on('connection/reset', () => {
              runningSessions.clear();
              seenPending.clear();
              setMood('idle', 'connection-reset');
            });
          } catch { /* 某些宿主没有该事件 */ }
        });

        // ---- ② 会话列表：当前会话切换 → 重建投影绑定
        ctx.inject(['sessions'], (sctx) => {
          const sessions = sctx.sessions;
          if (!sessions?.list?.subscribe) { mark('会话列表', '宿主没有 sessions.list'); return; }
          const sync = () => {
            let state;
            try { state = sessions.list.getSnapshot(); } catch { return; }
            // 字段名取自官方 session-controller：{ ids, byId, current, ... }
            const current = state?.current ?? null;
            if (current !== lastCurrentSession) {
              const hadPrevious = lastCurrentSession !== null;
              lastCurrentSession = current;
              bindProjections(sessions, current);
              if (hadPrevious) fire('session-switch', { id: String(current ?? '').slice(0, 8) });
              else fire('welcome', { id: String(current ?? '').slice(0, 8) });
            }
            // 用列表自带 running 字段兜底校准（status 事件可能因重连漏掉）
            try {
              const byId = state?.byId ?? {};
              for (const [id, row] of Object.entries(byId)) {
                if (row?.running === true) runningSessions.add(id);
                else if (row?.running === false) runningSessions.delete(id);
              }
              setMood(runningSessions.size > 0 ? 'working' : (store.mood === 'working' ? 'idle' : store.mood), 'list-sync');
            } catch { /* 忽略 */ }
          };
          add(sessions.list.subscribe(sync));
          sync();
          mark('会话列表', '已订阅');
        });

        // ---- ③ 待处理交互（权限/计划复核/提问）：只读快照，不接管流程
        ctx.inject(['uiSession'], (sctx) => {
          const pending = sctx.uiSession?.pendingInteractions;
          if (!pending?.subscribe || !pending?.getSnapshot) {
            mark('待处理交互', '宿主没有 uiSession.pendingInteractions');
            return;
          }
          const sync = () => {
            let map;
            try { map = pending.getSnapshot(); } catch { return; }
            if (!map || typeof map.forEach !== 'function') return;
            map.forEach((value, sessionId) => {
              const kind = value?.kind;
              if (kind !== 'approval' && kind !== 'plan-review' && kind !== 'question') return;
              const key = `${sessionId}|${kind}`;
              if (seenPending.has(key)) return;
              seenPending.add(key);
              fire('permission', { kind });
            });
          };
          add(pending.subscribe(sync));
          sync();
          mark('待处理交互', '已订阅');
        });

        // ---- ④ 连接状态：断连 → 网络错误
        ctx.inject(['connection'], (cctx) => {
          const conn = cctx.connection;
          const state = conn?.state;
          if (!state?.subscribe || !state?.getSnapshot) {
            mark('连接状态', '宿主没有 connection.state');
            return;
          }
          let last = null;
          const sync = () => {
            let now;
            try { now = state.getSnapshot(); } catch { return; }
            // 只在「从已连接落到非连接」时出声，避免启动期误报。
            if (last === 'connected' && now !== 'connected' && now !== undefined) fire('network-error', { state: now });
            if (now !== undefined) last = now;
          };
          add(state.subscribe(sync));
          sync();
          mark('连接状态', '已订阅');
        });
      }

      function stop() {
        for (const dispose of disposers) { try { dispose?.(); } catch { /* 忽略 */ } }
        disposers.length = 0;
        if (pressureDispose) { try { pressureDispose(); } catch { /* 忽略 */ } }
        pressureDispose = null;
        boundProjectionSessionId = null;
        runningSessions.clear();
        seenPending.clear();
      }

      return { start, stop };
    }

    // ================================================================ 浮动 Fairy

    const MOOD_LABEL = {
      idle: '待命',
      working: '工作中',
      success: '已完成',
      error: '异常',
      waiting: '等待授权',
      alert: '注意',
      celebrating: '已就绪',
    };

    function useSnapshot() {
      const [, force] = React.useReducer((x) => x + 1, 0);
      React.useEffect(() => subscribeStore(force), []);
      return store;
    }

    /**
     * 浮动 Fairy。静态用 fairy.svg（矢量，任意尺寸都清晰）；
     * 若需逐帧动画可选 frames（本版默认用 SVG + CSS 动效，省内存）。
     */
    function FloatingFairy() {
      const snap = useSnapshot();
      const cfg = snap.config?.fairy;

      // ⚠️⚠️ 2026-09-16 修掉一个**必崩**缺陷（React error #310）⚠️⚠️
      //
      // 原代码把 `if (!cfg?.enabled) return null;` 写在 useState/useEffect **之前**：
      //     const cfg = snap.config?.fairy;
      //     if (!cfg?.enabled) return null;                  // ← 提前 return
      //     const [staticMode, setStaticMode] = React.useState(false);   // Hook 1
      //     React.useEffect(...);                                        // Hook 2
      //
      // 而配置是**异步 fetch** 来的，所以渲染必然经历两个阶段：
      //   ① 首帧：cfg 还是 undefined → 只调 1 个 Hook（useSnapshot）→ return null
      //   ② 配置到达：cfg.enabled=true → 调 3 个 Hook
      // Hook 数量 1 → 3，React 直接抛 **error #310**
      // 「Rendered more hooks than during the previous render」。
      //
      // 后果特别隐蔽：错误发生在 React 的渲染栈里，`apply()` 的 try/catch
      // **完全抓不到**；官方 SlotErrorBoundary 捕获后调
      // `reportEntryError(..., { abdicate: true })`（shell.overlay 是 list 类型），
      // 把 entry 写进永久退位集合 abdicated ⇒ **此后永不渲染**。
      // 症状因此是「诊断说 floating:true，屏幕上却没有」—— 定位花了很久。
      //
      // 排查手段（可复用）：本机的官方 slots 服务暴露了监督接口
      //   `ctx.slots.onEntryError((key, entry, error, info) => …)`
      // 订阅它就能拿到渲染期崩溃的真实错误文本 —— 这是 DevTools 打不开时
      // 唯一能看见渲染错误的通道（React 渲染错误不进 apply 的 try/catch）。
      //
      // 铁律：**Hook 必须无条件、每次渲染都按同样顺序调用**。
      // 所有提前 return 一律放到 Hook 之后，且分支判断只能决定"渲染什么"，
      // 不能决定"调不调 Hook"。
      const [staticMode, setStaticMode] = React.useState(false);

      React.useEffect(() => {
        // 配置还没到时不必挂监听；但**不能**在此提前 return 掉 Hook 本身，
        // 所以这里只是让 effect 体按 cfg 是否存在决定做什么。
        if (!cfg?.enabled) return;
        const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        if (!mq) return;
        const on = () => setStaticMode(Boolean(mq.matches));
        on();
        mq.addEventListener?.('change', on);
        return () => mq.removeEventListener?.('change', on);
      }, [cfg?.enabled]);

      // ---- Hook 全部调用完毕，以下才是可以自由提前 return 的地方 ----
      if (!cfg?.enabled) return null;

      const size = cfg.size ?? 96;
      const mood = cfg.reactToState === false ? 'idle' : snap.mood;

      const label = mood === 'alert' && snap.pressurePercent != null
        ? `上下文 ${snap.pressurePercent}%`
        : MOOD_LABEL[mood] ?? mood;

      return jsx.jsx('div', {
        id: FLOATING_ID,
        'data-corner': cfg.corner ?? 'bottom-right',
        children: jsx.jsxs('div', {
          className: 'dsh-fairy-pet',
          'data-mood': mood,
          'data-static': staticMode ? 'true' : undefined,
          style: { width: size, height: size },
          title: `Fairy · ${label}`,
          children: [
            jsx.jsx('div', { className: 'dsh-fairy-ring' }),
            jsx.jsx('img', { src: `${ROUTE}/asset/fairy.svg`, alt: 'Fairy', draggable: false }),
            jsx.jsx('div', { className: 'dsh-fairy-hud', children: label }),
          ],
        }),
      });
    }

    // ================================================================ 设置面板

    function Row({ label, hint, children }) {
      return jsx.jsxs('div', { className: 'dsh-fairy-opt-row', children: [
        jsx.jsxs('div', { children: [
          jsx.jsx('div', { children: label }),
          hint ? jsx.jsx('div', { className: 'dsh-fairy-opt-hint', children: hint }) : null,
        ] }),
        children,
      ] });
    }

    function Toggle({ on, onChange, id }) {
      return jsx.jsx('input', {
        id,
        type: 'checkbox',
        checked: Boolean(on),
        onChange: (e) => onChange(e.target.checked),
      });
    }

    async function patchConfig(patch) {
      const res = await fetch(`${ROUTE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      store.config = json.config;
      publish();
      return json.config;
    }

    function FairySettings() {
      const snap = useSnapshot();
      const cfg = snap.config;
      const [busy, setBusy] = React.useState(false);
      const [status, setStatus] = React.useState(null);

      const update = (patch) => {
        setBusy(true);
        void patchConfig(patch)
          .catch((error) => note(`保存配置失败：${error?.message || error}`))
          .finally(() => setBusy(false));
      };

      const runCheck = () => {
        setBusy(true);
        void fetch(`${ROUTE}/status`)
          .then((r) => r.json())
          .then((j) => setStatus(j))
          .catch((error) => setStatus({ ok: false, error: String(error?.message || error) }))
          .finally(() => setBusy(false));
      };

      React.useEffect(() => {
        void fetch(`${ROUTE}/status`).then((r) => r.json()).then(setStatus).catch(() => {});
      }, []);

      if (!cfg) {
        return jsx.jsx('div', { children: snap.error ? `Fairy 主题加载失败：${snap.error}` : '正在加载 Fairy 主题…' });
      }

      const rows = [
        jsx.jsx(Row, {
          label: '启用 Fairy 主题',
          hint: '用 HDD 配色覆盖界面语义色（只改颜色，不动布局）',
          children: jsx.jsx(Toggle, { on: cfg.theme.enabled, onChange: (v) => update({ theme: { ...cfg.theme, enabled: v } }) }),
        }, 'theme'),
        jsx.jsx(Row, {
          label: '浮动 Fairy',
          hint: '右下角驻留，跟随 agent 真实状态变化',
          children: jsx.jsx(Toggle, { on: cfg.fairy.enabled, onChange: (v) => update({ fairy: { ...cfg.fairy, enabled: v } }) }),
        }, 'fairy'),
        jsx.jsx(Row, {
          label: '跟随 agent 状态',
          hint: '关闭后只作静态装饰，不随任务变化',
          children: jsx.jsx(Toggle, { on: cfg.fairy.reactToState, onChange: (v) => update({ fairy: { ...cfg.fairy, reactToState: v } }) }),
        }, 'react'),
        jsx.jsx(Row, {
          label: '事件音效',
          hint: '44 段预置语音；默认关闭（首次需一次点击解锁浏览器音频）',
          children: jsx.jsx(Toggle, { on: cfg.voice.enabled, onChange: (v) => update({ voice: { ...cfg.voice, enabled: v } }) }),
        }, 'voice'),
        jsx.jsx(Row, {
          label: '大小',
          hint: `${cfg.fairy.size}px`,
          children: jsx.jsx('input', {
            type: 'range', min: 48, max: 240, step: 8, value: cfg.fairy.size,
            onChange: (e) => update({ fairy: { ...cfg.fairy, size: Number(e.target.value) } }),
          }),
        }, 'size'),
      ];

      return jsx.jsxs('div', { children: [
        jsx.jsx('p', { className: 'dsh-fairy-opt-hint', children: 'Fairy —— HDD 主题、浮动形象与事件音效。本仓库只含代码；美术素材需自备（见 ASSETS.md）。' }),
        ...rows,
        jsx.jsx('div', { className: 'dsh-fairy-opt-actions', children: [
          jsx.jsx('button', { type: 'button', disabled: busy, onClick: runCheck, children: '重新自检' }),
          jsx.jsx('button', {
            type: 'button', disabled: busy,
            onClick: () => { void player.unlock().then(() => player.fire('success')); },
            children: '试听',
          }),
          jsx.jsx('button', {
            type: 'button', disabled: busy,
            onClick: () => update({ fairy: { ...cfg.fairy, corner: cfg.fairy.corner === 'bottom-right' ? 'bottom-left' : 'bottom-right' } }),
            children: '换边',
          }),
        ] }),
        status ? jsx.jsxs('div', { className: 'dsh-fairy-diag', children: [
          jsx.jsx('div', { children: `素材：语音 ${status.sounds}/${status.expectSounds}，dark 帧 ${status.frames?.dark ?? '-'}/120，light 帧 ${status.frames?.light ?? '-'}/120` }),
          jsx.jsx('div', { children: `主题已注入：${diagnostics.themeApplied ? '是' : '否'}　AudioContext：${diagnostics.audioContextState}` }),
          jsx.jsx('div', { children: `状态：${store.mood}${store.pressurePercent != null ? `　上下文 ${store.pressurePercent}%` : ''}` }),
          ...Object.entries(diagnostics.subscriptions).map(([k, v]) => jsx.jsx('div', { children: `${k}：${v}` }, k)),
          ...diagnostics.notes.slice(-4).map((n, i) => jsx.jsx('div', { children: `! ${n.message}` }, `note-${i}`)),
        ] }) : null,
      ] });
    }

    // ================================================================ 引擎装配

    const player = createPlayer();
    let detectors = null;

    function injectSlot(ctx, definition, component) {
      let disposeRegistration = null;
      const release = () => {
        const dispose = disposeRegistration;
        disposeRegistration = null;
        try { dispose?.(); } catch { /* 卸载期忽略 */ }
      };
      return ctx.slots.inject(definition.name, () => {
        release();
        const registration = ctx.slots.register(definition, component);
        disposeRegistration = typeof registration === 'function' ? registration : null;
        return release;
      });
    }

    async function loadConfig() {
      try {
        const res = await fetch(`${ROUTE}/config`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        store.config = json.config;
        store.ready = true;
      } catch (error) {
        store.error = String(error?.message || error);
        note(`读取配置失败：${store.error}`);
      }
      publish();
    }

    function applyThemeIfEnabled() {
      const theme = store.config?.theme;
      if (theme?.enabled === false) { removeTheme(); return; }
      applyTheme(theme?.mode ?? 'auto');
    }

    function apply(ctx) {
      // ★★★ 本函数**任何情况下都不允许抛错**。★★★
      //
      // 依据 DSH web boot 的 assertEntriesActive() 实现：
      //   fiber === undefined  → "import failed"      （factory 抛错）
      //   state === 'pending'  → "waiting for services"（inject 声明永远等不到）
      //   state 其它           → 直接报状态名         （apply 抛错）
      // 三者任一命中就 throw，外层 catch 调 this.page.fail() **接管整个界面**
      // ⇒ 插件出错会让 DSH 打不开。所以这里全量 try/catch：只降级，绝不外抛。
      //
      // 同理，本插件**不写 `inject: ['slots']`**：那会让 entry 卡在 pending
      // 等一个本可不等的东西。改为 ctx.inject(['slots'], …) 延迟注册插槽
      // —— 这也是官方 5 个客户端插件的写法（ui-commands / ui-input-trigger 等）。
      // 好处有二：① 主题不再被 slots 就绪时机拖延，首屏立即变色；
      //          ② slots 万一永远不来，只是没有浮动形象，**不会把 DSH 拖成失败页**。

      diagnostics.mounted = true;
      try { globalThis.__FAIRY_THEME_DIAG__ = diagnostics; } catch { /* 无所谓 */ }

      // 插槽挂载结果（写进 <html data-fairy-*> 供外部读取）
      let floatingMounted = false;
      let settingsMounted = false;
      const disposeSlots = [];

      // 落一个 DOM 标记，作为「apply 真的被调用」的可截图证据
      // （DevTools 读不到渲染进程时，这是唯一能远程确认的通道）。
      //
      // ★ 2026-09-16 升级：不只标「活着」，还把**关键内部状态**写进属性。
      //   起因：主题生效了，浮动形象却没出现，而 globalThis 上的
      //   __FAIRY_THEME_DIAG__ 从外部读不到 ⇒ 只能猜。
      //   改成把状态写进 <html> 的 data-* 属性后，用 DOM 快照/截图即可读出。
      try {
        const stamp = document.createElement('meta');
        stamp.id = 'dsh-fairy-theme-alive';
        stamp.setAttribute('data-version', '0.2.0');
        stamp.setAttribute('data-at', String(Date.now()));
        document.head.appendChild(stamp);
      } catch { /* 无所谓 */ }

      /** 把内部状态写到 <html data-fairy-*>，供外部读取。 */
      const markHtml = () => {
        try {
          const el = document.documentElement;
          el.setAttribute('data-fairy-mounted', '1');
          el.setAttribute('data-fairy-has-slots', String(Boolean(ctx?.slots)));
          el.setAttribute('data-fairy-config-ready', String(Boolean(store.ready)));
          el.setAttribute('data-fairy-config-error', String(store.error ?? ''));
          el.setAttribute('data-fairy-floating', String(Boolean(floatingMounted)));
          el.setAttribute('data-fairy-settings', String(Boolean(settingsMounted)));
          el.setAttribute('data-fairy-notes', String(diagnostics.notes.length));
          const last = diagnostics.notes[diagnostics.notes.length - 1];
          if (last) el.setAttribute('data-fairy-last-note', String(last.message).slice(0, 180));
        } catch { /* 无所谓 */ }
      };

      /**
       * 把诊断 POST 回宿主落盘（见 index.js 的 handlers.diag）。
       *
       * 为什么必须这么做：客户端跑在浏览器里，外部读不到它的 globalThis，
       * DevTools 也打不开 —— 「插槽注册成功没」「配置加载成功没」全靠猜。
       * 回流成文件后，这些问题都变成离线可读的事实。
       */
      let diagSent = false;
      const reportDiag = (extra) => {
        try {
          void fetch(`${ROUTE}/diag`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              hasSlots: Boolean(ctx?.slots),
              configReady: Boolean(store.ready),
              configError: store.error ?? null,
              floating: floatingMounted,
              settings: settingsMounted,
              hasUI: HAS_UI,
              notes: diagnostics.notes.slice(-12).map((n) => n.message),
              subscriptions: { ...diagnostics.subscriptions },
              themeApplied: Boolean(diagnostics.themeApplied),
              ...extra,
            }),
          }).then(() => { diagSent = true; }, () => { /* 上报失败不影响功能 */ });
        } catch { /* 忽略 */ }
      };

      // ---- ① 主题：最先执行，且不依赖任何服务（最坏也只是不变色）----
      try { applyTheme('auto'); } catch (error) { note(`主题注入失败：${error?.message || error}`); }
      try {
        void loadConfig().then(
          () => { try { applyThemeIfEnabled(); } catch { /* 忽略 */ } markHtml(); reportDiag({ phase: 'config-loaded' }); },
          () => { markHtml(); reportDiag({ phase: 'config-error' }); },
        );
      } catch (error) { note(`配置加载发起失败：${error?.message || error}`); }
      markHtml();
      reportDiag({ phase: 'apply-entry' });

      // ---- ② 配置变化订阅 ----
      try {
        let lastVoiceEnabled = null;
        subscribeStore(() => {
          try {
            applyThemeIfEnabled();
            const voiceOn = store.config?.voice?.enabled ?? false;
            if (voiceOn !== lastVoiceEnabled) {
              lastVoiceEnabled = voiceOn;
              recordEvent('voice-toggle', voiceOn);
            }
            player.setVolume(store.config?.voice?.volume);
          } catch (error) { note(`订阅回调失败：${error?.message || error}`); }
        });
      } catch (error) { note(`订阅失败：${error?.message || error}`); }

      // ---- ③ 插槽：挂到官方 shell.overlay / settings.section ----
      //
      // 官方契约（asar 内 cordis-client-runner 的 slots 契约表原文）：
      //   key: "shell.overlay", kind: "list", scope: "root"
      //   "Frame-wide floating layer, above every column and outside their
      //    scroll containers. … The layer itself is click-through — entries
      //    opt back into pointer events — so an occupant never blocks the app."
      //   "For a surface of your own that floats over the whole app, register
      //    into `shell.overlay` instead (a list slot: additive …)"
      // ⇒ 名字完全正确，正是为这种需求准备的官方座位。
      //
      // ⚠️ `ctx.slots` 必须先经 `inject: ['slots']` 声明才会挂上。
      //    2026-09-16 我第一次改错：为规避「pending 卡死」把 inject 删了，
      //    结果 slots 为 undefined、插槽静默不注册（主题却照旧生效 —— 因为
      //    主题只碰 document.head，不依赖任何服务），症状是迷惑性极强的「半生效」。
      //    反证：asar 内 **31 个**官方客户端插件全部声明 inject 含 "slots" 且都正常。
      //    真正的抗失败防线是 apply() 全量 try/catch + factory 经 platform() 包装。
      //
      // ⚠️ 已知的**渲染门禁**：FloatingFairy 首行是
      //      `const cfg = snap.config?.fairy; if (!cfg?.enabled) return null;`
      //    ⇒ 配置没成功加载时它渲染 null（不报错、不留痕）。
      //    settings.section 同理依赖 store.ready。
      //    所以「插槽注册成功」≠「界面可见」，必须配置也加载成功。
      const setupSlots = (scope) => {
        const slots = scope?.slots;
        if (!slots) { note('slots 服务不可用，跳过插槽注册（主题仍生效）'); return; }
        // 没有 jsx 运行时就只保留主题，不注册任何会渲染的组件。
        const Floating = HAS_UI ? FloatingFairy : Noop;
        const Settings = HAS_UI ? FairySettings : Noop;
        try {
          const d1 = injectSlot(scope, { name: 'shell.overlay', id: 'fairy-floating', order: 80 }, Floating);
          if (typeof d1 === 'function') { disposeSlots.push(d1); floatingMounted = true; }
        } catch (error) { note(`shell.overlay 注册失败：${error?.message || error}`); }
        try {
          const d2 = injectSlot(scope, { name: 'settings.section', id: 'fairy-theme', order: 45, label: () => 'Fairy 主题' }, Settings);
          if (typeof d2 === 'function') { disposeSlots.push(d2); settingsMounted = true; }
        } catch (error) { note(`settings.section 注册失败：${error?.message || error}`); }
      };
      try {
        if (ctx?.slots) setupSlots(ctx);
        else note('ctx.slots 缺失，浮动形象与设置面板不可用（主题仍生效）');
      } catch (error) { note(`插槽初始化失败：${error?.message || error}`); }
      markHtml();
      reportDiag({ phase: 'slots-done' });

      // ---- ④ 状态检测器 ----
      try {
        detectors = createDetectors(ctx, player);
        detectors.start();
      } catch (error) { note(`检测器启动失败：${error?.message || error}`); }

      // ---- ⑤ 首次交互解锁音频 + 状态标记定时刷新 ----
      try {
        const unlockFromGesture = () => { void player.unlock(); };
        window.addEventListener('pointerdown', unlockFromGesture, { passive: true });
        window.addEventListener('keydown', unlockFromGesture, { passive: true });
        // 配置是异步加载的，且插槽回调可能稍后才跑；定时重写标记，
        // 让外部随时能读到**当下**的真实状态（读取方无需等待时机）。
        const markTimer = setInterval(() => { markHtml(); }, 1000);
        // ---- ⑥ 生命周期清理 ----
        ctx.effect(() => () => {
          clearInterval(markTimer);
          disposeSlots.forEach((dispose) => { try { dispose(); } catch { /* 忽略 */ } });
          window.removeEventListener('pointerdown', unlockFromGesture);
          window.removeEventListener('keydown', unlockFromGesture);
          try { detectors?.stop(); } catch { /* 忽略 */ }
          detectors = null;
          try { removeTheme(); } catch { /* 忽略 */ }
          try { player.dispose(); } catch { /* 忽略 */ }
        }, 'dsh-fairy-theme lifecycle');
      } catch (error) { note(`生命周期注册失败：${error?.message || error}`); }
    }

    // ★ 必须声明 inject: ['slots'] —— `ctx.slots` 靠它才会挂上。
    //
    // 2026-09-16 更正：我曾为规避「entry 卡 pending 会触发 assertEntriesActive()
    // 把整页打成失败页」而删掉这行，**那是错的**，代价是 slots 为 undefined、
    // 浮动形象与设置面板静默失效（而主题照旧生效，症状极具迷惑性）。
    //
    // 实测反证：asar 内 **31 个**官方客户端插件全部声明 inject 含 "slots"
    // （sidebar / chat / theme / conversation / …），全部正常工作
    // ⇒ 声明它不会 pending。`slots` 由 dsh-client-ui-renderer 提供，
    //   而 renderer 在 boot 清单里 immediately:true，必定先于本插件就绪。
    //
    // 真正的抗失败防线不是删声明，而是：
    //   ① factory 经 platform() 包装，缺模块不抛错；
    //   ② apply() 六段全量 try/catch，任何异常只降级、不外抛。
    return { apply, inject: ['slots'] };
  },
});
