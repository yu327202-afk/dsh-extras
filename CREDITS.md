# 出处与致谢 · Sources & Credits

本仓库的代码为本项目自研。但其中一部分**是在参考社区作品之后写成的**，
按开源惯例应当写明出处。这里逐项交代清楚，包括"参考到什么程度"。

---

## 一句话结论

**没有任何文件是照抄的。** 实测比对结果：与本仓库最相关的上游 `dsh-fairy-voice@1.0.5`
逐行重合率 **4.2%**，且重合部分**全部是框架 boilerplate**
（`window.__ModuleLoader__.load({`、`} catch (error) {`、`return false;` 这类）。
命名函数交集 6 个，全是 `apply` / `read` / `start` 这种通用词。

但**有几处是明确借鉴了上游的写法或契约**，下面逐条列出。

---

## 一、`plugins/dsh-fairy-theme`

### 1.1 参考了 `dsh-fairy-voice@1.0.5`（代码写法）

该包发表于 npm（`dsh-fairy-voice`），无 LICENSE 文件。以下三处**写法**参考了它：

| 位置 | 参考内容 | 程度 |
|---|---|---|
| `lib/index.js` | `register()` 的返回值即 disposer —— "与 dsh-fairy-voice 1.0.5 同一写法" | 一行模式 |
| `lib/client.js` | 通过 `binding.eventSource` 读会话事件的思路（**实测该 API 在 core 0.1.5 不存在，已改用官方 `remote.$on` 契约**） | 思路参考，实现完全不同 |
| 整体 | 客户端插件的 `window.__ModuleLoader__.load` + factory 返回 exports 形态 | 平台约定，非该包独创 |

> 这三处都是**接口约定与惯用法**级别的参考，不是实现搬运。
> 源码中原有的出处注释（`lib/client.js` 第 613 行、`lib/index.js` 第 379 行）**予以保留**。

### 1.2 美术素材（**不随本仓库分发**）

详见 [`ASSETS.md`](ASSETS.md)。简要：

| 素材 | 来源 | 状态 |
|---|---|---|
| Fairy 形象（240 帧 / `fairy.svg` / 头像） | 社区作品 `pi-fairy-animation`、`FairyAvatar` | 角色版权属米哈游《绝区零》；**未分发** |
| 44 段事件语音 | 社区作品 `pi-fairy`，经 QQ 群文件流转 | 来源不可追溯；**未分发** |
| 配色取值 | 从上述头像与动画帧实际取色 | 仅取色值，不涉素材本身 |

相关社区项目 [Fairy-DSH](https://github.com/Chengzhibense/Fairy-DSH)（Fairy 人格与视觉插件套件）。

### 1.3 官方平台约定（非第三方）

以下来自 **DSH 官方**而非社区，属于平台规范：

- `--dsw-alias-*` / `--dsw-static-deepseek-*` 主题变量体系（官方 `dsh-client-ui-theme`）
- `remote.$on` 契约事件、`binding.session.projections`
- `dsh.client.inject` / `dsh.bundle.patch` 声明格式

`test/official-vars.json` 是从官方 `app.asar` 内**实测抽取**的变量名快照，
用于断言"我们覆盖的变量官方确实存在"。这份快照的作者是官方，我们只是转录。

---

## 二、`plugins/dsh-imagegen-relay`

**独立实现**，无代码参考。与 [`dsh-image-gen`](https://www.npmjs.com/package/dsh-image-gen)
（作者 `shanliuling`，MIT，[仓库](https://github.com/shanliuling/dsh-image-gen)）是**互补关系**：

- `dsh-image-gen` 是生图插件，其 `openai-compat` provider 只能填一个 `baseURL`
- 本插件是配套的**渠道聚合器**，把多家上游合成一个地址给它用

本插件**不包含** `dsh-image-gen` 的任何代码，也不修改它。

---

## 三、`plugins/dsh-desktop-locale-fix`

**独立实现**，无社区代码参考。

但它的**存在理由**来自对 DSH 官方出厂代码的阅读（`app.asar` 内）：

- `NOTIFICATION_COPY[runtime.locale]` 的取值链路
- `createHostRuntime(rpc, snapshot)` 里 `let locale = snapshot.locale`
- `setLocalePreference()` 的调用者分析

这些是**对官方代码的阅读理解**，不是对其代码的复制或修改。
本插件是纯用户态旁路修复，**不改 `app.asar`**。

---

## 四、`tools/`

`dsh-status.mjs`、`dsh-session-events.mjs` 均为独立实现。

其中若干**判定逻辑**来自对官方 `app.asar` 出厂代码的反推
（例如 `dsh-agent-instructions` 的字节预算裁剪算法 `renderInstructionContext`），
属于"读懂行为后自己写实现"，非复制。相关推导在源码注释中已标注来源文件与行号。

---

## 五、许可证说明

| 内容 | 许可证 |
|---|---|
| 本仓库源代码 | MIT（见根目录 `LICENSE`） |
| 第三方美术素材 | **不在覆盖范围内，且不在本仓库中** |

本仓库**有意不含**任何第三方版权素材。若你自行补齐，那部分权利与授权由你自行确认。

---

## 六、如果权利人认为有不当之处

本仓库的立场是**明确标注、不占为己有**。如果你（或你代表的权利人）认为
本仓库任何内容侵犯了你的权利，请开 issue 说明，我会立即处理——包括但不限于
移除相关代码、补充署名、或调整许可证。

我们尊重所有上游作者的工作。这份文件存在的意义就是**把出处交代清楚**。
