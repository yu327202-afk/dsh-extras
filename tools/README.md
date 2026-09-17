# tools

给 DSH Desktop 的**只读运维小脚本**。零依赖（只用 Node 内置模块），不改任何文件。

```powershell
# 在 DSH Desktop 里跑必须带 ELECTRON_RUN_AS_NODE=1
# 因为 process.execPath 指向 Electron 的 "DSH Desktop.exe"，不是 node
$env:ELECTRON_RUN_AS_NODE = 1
node tools/dsh-status.mjs
```

> 本机唯一可用的 node 通常在这里：
> `%APPDATA%\DSH Desktop\runtime-commands\private\node-bin\node.cmd`

---

## `dsh-status.mjs` —— 用量与压缩状态速查

读 `~/.dsh/storages/session_projcache/sessions/*.json`，报出：

- 每个会话的 preset / 轮数 / 步数 / 输入 token / 缓存命中率 / 上下文压力
- 当前会话的明细（未缓存、缓存命中、输出）
- **压缩到底有没有真的发生** —— 去追加式会话事件日志里数 `compaction/start`、
  `compaction/prune`、被替换的工具结果条数

最后一条是这个脚本最值钱的地方：**配置里写了压缩阈值 ≠ 压缩真的触发了。**
这里给的是事件日志里的一手证据，不是配置的回读。

> ⚠️ **一个容易踩的坑**：某些第三方插件会借用**官方同名的** `compaction/prune`
> 事件类型写自己的审计记录。直接数事件条数会把审计误报成"剪裁次数"。
> 本脚本的判据是「该事件是否被其它事件以 `sourceEventSeqs` 引用」——
> 官方剪裁事件不被任何事件引用，借用的会被紧随的载体消息引用。

---

## `dsh-session-events.mjs` —— 读原始会话事件日志

DSH 的会话事件日志是**多帧 zstd** 追加文件（`session.v3.jsonl.zstd`），
不能直接 `zcat`。本脚本按 magic `28 B5 2F FD` 逐帧解压再拼起来。

```powershell
node tools/dsh-session-events.mjs              # 本工作区最新会话
node tools/dsh-session-events.mjs <会话id子串>  # 指定会话
node tools/dsh-session-events.mjs --all        # 全部会话的压缩事件汇总
node tools/dsh-session-events.mjs --prunes     # 量工具结果被剪掉多少字符
```

用途：看上下文"锯齿"曲线、定位压缩/剪裁发生在第几步、核对剪裁配置是否真生效。

---

## 为什么这些脚本值得单独发

它们的判据都是从**出厂代码里反推**出来的，不是猜的：

- 「压缩阈值 20%」是 preset 里的数字，但真正决定行为的是
  `dsh-agent-instructions` 的预算裁剪算法 —— 裁剪从**数组第一个文件**开始丢，
  所以 user-global 的 `~/.dsh/AGENTS.md` 永远最先被牺牲。
- 「工具结果被剪裁」表面上是 `compaction/prune` 事件计数，
  实际得排除第三方插件借用同名事件写的审计。

**先取证再下结论**是这些脚本存在的全部理由。
