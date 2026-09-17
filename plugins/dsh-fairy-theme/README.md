# dsh-fairy-theme

给 DeepSeek Harness Desktop 的 **Fairy 主题 + 浮动形象 + 事件音效**。
代码为本仓自研。

适配基线：**DSH Desktop core 0.1.5-rc.1**，profile 名 `desktop`。

> ⚠️ **本仓库只含代码，不含美术素材。** Fairy 形象版权属米哈游《绝区零》，
> 语音与帧图来自社区作品、来源链路不可追溯 —— 再分发它们不符合 GitHub 的
> [可接受使用政策](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies#3-intellectual-property-authenticity-and-private-information)。
> 没有素材插件照常工作（降级为纯主题），补齐方法见 **[ASSETS.md](ASSETS.md)**。

---

## 它做什么

| 能力 | 实现方式 | 是否依赖 DOM 选择器 |
|---|---|---|
| **HDD 风格配色** | 覆盖官方 `--dsw-alias-*`（57 个）+ `--dsw-static-deepseek-*` 品牌色阶 | 否 |
| **浮动 Fairy** | 挂官方 `shell.overlay` 插槽，React 渲染 | 否 |
| **状态联动** | 订阅 `remote.$on` 契约事件 + `contextPressure` 投影 | 否 |
| **事件音效** | 44 段预置 WAV，经本地静态路由播放，无外联 | 否 |

**一个 DOM 选择器都不用** —— 官方主题包是唯一的变量来源，颜色靠覆盖变量实现，
版式改了也不碎。这是本项目相对社区方案最重要的差异。

---

## ⚠️ 踩过的坑：插件跑得好好的，界面纹丝不动

2026-09-16 实测记录，**这是本项目最值钱的一条经验**。

### 现象

前两次重启后界面毫无变化。所有"插件没加载"方向的排查**全部证伪**：

- 插件**确实在**客户端 boot 清单里（`__DSH_BOOT__.entries` 第 46 项）
- bundle 已被浏览器**预载并注册**（`batches[1]` 那条含 59 个 entry 的 combo 批里有它）
- 条目结构与已验证可用的 `dsh-retrace` 逐字段一致
- DSH 的 `assertEntriesActive()` 会在**任何** entry 未激活时抛错并让整个 app
  显示失败页 —— 界面正常渲染就证明**它已激活、`apply()` 已执行**

### 真正原因：覆盖面，不是加载

官方 79 个 `--dsw-alias-*` 变量的**被引用次数极度不均**：

| 变量 | 被引用 | 最初是否覆盖 |
|---|---|---|
| `label-tertiary` / `label-primary` / `label-secondary` | 197 / 191 / 144× | ❌ |
| `interactive-bg-hover` | 89× | ❌ |
| `label-caption` | 73× | ❌ |
| `border-l2/l4/l1/l3` | 47/37/32/30× | ❌ |
| `bg-layer-1` / `bg-base` | 36 / 22× | ❌ |
| `brand-primary-new-color…` | **7×** | ✅ |

最初只改了 13 个变量，**引用次数合计仅约 120 次**，且集中在小众强调色。
⇒ 「代码执行了」≠「产生了可见效果」。**判定 UI 改动是否生效，
必须统计它实际影响的渲染表面积。**

### 三条修正（已落地）

1. **覆盖高频变量**：13 → **57 个 alias**，引用次数合计 **120 → 1263（10.5×）**，
   并额外覆盖 `--dsw-static-deepseek-*` 品牌色阶（有地方绕过 alias 直接用原语，
   最典型的就是发送按钮）。
2. **`html ` 前缀 + `!important`**：官方 `<style>` 与我们的选择器特异性相同，
   谁在文档后面谁生效、顺序不受控。抬特异性后**不依赖插入顺序**。
3. **加可远程读取的取证通道**：宿主写 `~/.dsh/fairy-theme/plugin.log`；
   客户端往 `document.head` 插 `<meta id="dsh-fairy-theme-alive">`。

### 三个"判据本身失效"的教训

排查时最危险的**不是找不到原因，而是拿一个无效的判据当依据**：

| 曾经用的判据 | 为什么无效 |
|---|---|
| 「`~/.dsh/fairy-theme/config.json` 不存在 ⇒ apply 没跑」 | `readConfig()` **只读不写**，此文件本就不会被创建 |
| 「宿主日志里没有 fairy ⇒ 插件没加载」 | `console.log` 在 Electron 主进程**不落盘** |
| 「client 端无法取证」 | 实为可取证（写入 DOM 标记后截图即可确认） |

前两条让我在**错误方向上连查两轮**。**测试「判据本身是否有效」，比测试结论更重要。**

---

## 素材来源与授权

| 素材 | 来源 | 说明 |
|---|---|---|
| 44 段事件语音 | 社区 `pi-fairy` | 源文件来自用户提供的 QQ 群文件 |
| 240 张动画帧（dark/light 各 120，256×256） | 社区 `pi-fairy-animation` | |
| `fairy.svg` | 社区 `pi-fairy-animation` | 矢量，CSS 动效驱动 |
| 4096×4096 头像 | 社区 `FairyAvatar` | 圆/方两张备用 |

上游 `pi-fairy` 仅支持 macOS，Windows 无播放器路径；本项目**只取素材**，
检测与播放链路完全自研。Fairy 形象版权属米哈游《绝区零》。

---

## 安装

```powershell
# profile 名必须是 desktop —— 装错 profile 会「装成功了但界面上什么都没有」
dsh plugin --profile desktop add link:C:/dsh-fairy-theme
```

> ⚠️ **路径不能含空格**。pnpm 会把 `link:F:/DSH desktop/...` 按空格拆成两个垃圾依赖。
> 若仓库在含空格路径下，先建 junction：`mklink /J C:\dsh-fairy-theme "<真实路径>"`。

装完**必须重启 DSH**。插件在启动时载入，不重启看到的一直是旧行为。

## 卸载 / 回滚

```powershell
dsh plugin --profile desktop remove dsh-fairy-theme
```
再重启。素材播种目录 `~/.dsh/fairy-theme/` 可整个删除。

---

## 配置

`~/.dsh/fairy-theme/config.json`，也可在「设置 → Fairy 主题」里改（改完即时生效，无需重启）。

```json
{
  "theme": { "enabled": true, "mode": "auto", "ornaments": true },
  "fairy": { "enabled": true, "size": 96, "corner": "bottom-right", "reactToState": true },
  "voice": { "enabled": false, "volume": 0.6 }
}
```

- `theme.mode`：`auto` 跟随系统/官方开关；`dark` / `light` 强制
- `voice.enabled` 默认 **false** —— 浏览器要求一次用户手势才能出声，插件用全局
  `pointerdown` / `keydown` 解锁，但默认不打扰

---

## 状态联动

浮动 Fairy 的情绪由**真实 agent 事件**驱动，不是随机动画：

| 宿主信号 | 契约来源 | 反应 |
|---|---|---|
| `api-session/status(sessionId, running)` | `remote.$on`（19 个合法键之一） | 有会话在跑 → `working`，全部停下 → `success` |
| `api-session/added` / `removed` | 同上 | `new-session` / `goodbye` 音效 |
| `api-session/error(sessionId, message)` | 同上 | `error` |
| `uiSession.pendingInteractions` | 只读快照 | 出现审批/复核/提问 → `waiting` |
| `contextPressure` 投影 | `binding.session.projections.faceOf()` | ≥80% → `alert`（回落到 75% 以下才重新武装） |
| `connection.state` | `connection` 服务 | 由已连接转为断开 → `network-error` |

### 已知与社区方案的差异（重要）

社区 `dsh-fairy-voice@1.0.5` 依赖 `binding.eventSource` 读取会话日志事件
（`turn/start`、`turn/end`、`compaction/*`、`llm/retry`）。
**该 API 在 core 0.1.5-rc.1 中不存在**（asar 全量扫描 0 命中），
所以本插件改用上面这套**有契约保证**的通路。

代价：`compaction/*`（压缩开始/结束）与 `llm/retry`（重试）这两个触发器
在 0.1.5 上**拿不到信号**，对应音效不会触发（配置里的相关条目保留，供未来版本恢复）。
另外 `quota-warning` 依赖桌面壳桥（`refreshBalance`），0.1.5 的 web 侧没有，同样不触发。

每个信号源独立 `try/catch`：任何一路失效只表现为「某个特效不生效」，插件不会整个哑掉。

---

## 排查

插件加载后可在 DevTools 里看 `__FAIRY_THEME_DIAG__`：

```js
__FAIRY_THEME_DIAG__.subscriptions   // 每路信号的订阅结果
__FAIRY_THEME_DIAG__.events          // 最近 20 条触发
__FAIRY_THEME_DIAG__.notes           // 告警
```

设置面板底部也有等效的「重新自检」，会显示素材数量、主题注入状态、AudioContext 状态。

**自检命令**

```powershell
$env:ELECTRON_RUN_AS_NODE=1
node test/selftest.mjs              # 素材完整性 + 能否挂载
node test/contract-test.mjs         # 检测层是否订阅到正确契约
node test/verify-live-contract.mjs  # host inject / client exports 契约守门
```

### 踩过的坑：装好了，界面上什么都没有

**2026-09-16 实测**。插件装进 profile、`dump-config` 里能看到、素材也播种了，
重启后界面**毫无变化**——设置里没有「Fairy 主题」，右下角没有 Fairy，配色还是官方蓝。

定位过程与两个真实原因：

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | host 侧完全没日志，播种目录时间戳是旧的 | `lib/index.js` **缺 `export const inject`** | 补 `export const inject = ['webServer']` |
| 2 | （预防性核对）client 侧 exports 形状 | 官方/第三方都用 `module.exports`，我用裸对象返回 | **确认合法**：`materialize()` 的实现是 `exports: registered(factory(require))`，直接取返回值 |

顺带确认的两条**重要事实**（别再被误导）：

- **`react` / `react/jsx-runtime` / `...ui-slots` / `...ui-primitives` 是平台种子**
  （从 `dsh-web-frontend` 的 `staticModules` 实测抽出，共 9 个），
  `require` 它们**不需要**写进 `dsh.client.inject`。官方 25 个客户端插件都
  `require('...primitives')` 却没声明它，就是这个原因。
- `dsh.client.inject` 里的包名**找不到就静默跳过**（`arriveGraphRow` 里
  `graphRows.get(packageName)` 为 undefined 时不报错），所以多写不会炸、少写也不会立刻报错。

**排查这类「静默不生效」的手法是**：看
`%APPDATA%\DSH Desktop\Partitions\dsh-desktop-renderer\Cache\Cache_Data\` 里的渲染缓存
——能直接确认浏览器是否真的收到了你的 bundle、以及它是否在 boot 图的
`/plugins/??...` 合并 URL 里。

---

## 未验证事项

- 界面实际观感仍需重启后目视确认。**首次安装重启后实测未生效**（见上节根因），
  已修复但仍**未在真实界面上确认过效果**
- 由 `--dsw-alias-*` 覆盖推出的配色，在少数非语义用法（硬编码色值）处不会生效
- `fairy.svg` 走 CSS 动效，未使用 240 张帧图；帧图仅作备用（若你自行补齐素材）
