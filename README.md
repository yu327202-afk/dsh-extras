# dsh-extras

给 **DeepSeek Harness Desktop** 的社区插件与工具集。每个插件独立可用。

> 非官方项目，与 DeepSeek 官方无关联。适配基线 **DSH Desktop core 0.1.5-rc.1**。

---

## 包含什么

| 目录 | 是什么 | 状态 |
|---|---|---|
| [`plugins/dsh-imagegen-relay`](plugins/dsh-imagegen-relay/) | 把多家生图渠道聚合成**一个** OpenAI 兼容端点，供 `dsh-image-gen` 使用 | 已实测运行 |
| [`plugins/dsh-desktop-locale-fix`](plugins/dsh-desktop-locale-fix/) | 修复 0.1.5 通知语言重启后回落英文的缺陷 | 已实测运行 |
| [`plugins/dsh-fairy-theme`](plugins/dsh-fairy-theme/) | HDD 风格主题 + 浮动形象 + 事件音效（**素材需自备**） | 代码已验证，界面观感待确认 |
| [`tools/`](tools/) | 无依赖的运维小脚本（用量统计、事件日志、预算校验等） | 已实测运行 |

---

## 装哪个、怎么装

三个插件都通过 DSH 自带的插件命令安装，`--profile` 名要和你实际在用的 profile 一致
（官方桌面端默认是 `desktop`）：

```powershell
dsh plugin --profile desktop add link:C:/path/to/plugin-dir
```

> ⚠️ **路径不能含空格。** pnpm 会把 `link:F:/my dir/...` 按空格拆成两个垃圾依赖。
> 路径带空格时先建 junction：`mklink /J C:\my-plugin "<真实路径>"`。

> ⚠️ **装完必须重启 DSH。** 插件在启动时载入，不重启看到的永远是旧行为。

各插件自己的 README 里有详细配置、排查与回滚说明。

---

## 关于素材

`dsh-fairy-theme` **只分发代码，不分发美术素材**。Fairy 形象版权属于第三方，
语音来源不可追溯，把它们放进公开仓库属于再分发他人版权素材。
原因与补齐方法见 [`plugins/dsh-fairy-theme/ASSETS.md`](plugins/dsh-fairy-theme/ASSETS.md)。

代码用 MIT 开源；素材由使用者自行准备并自行确认授权。

---

## 出处与致谢

部分插件是在**参考社区作品之后**写成的。出处、参考程度、以及"哪些是自研、哪些是借鉴"
逐条写在 [`CREDITS.md`](CREDITS.md) 里。

简要结论：**没有任何文件是照抄的**。与最相关的上游 `dsh-fairy-voice@1.0.5`
逐行重合率 4.2%，且重合的全是框架 boilerplate。有几处**写法与契约**明确借鉴，
已在源码注释与 `CREDITS.md` 中标注。

---

## 这些插件解决的是什么问题

都不是"为了做插件而做插件"，而是踩了坑之后留下的：

- **imagegen-relay** —— `dsh-image-gen` 的 `openai-compat` provider 只能填**一个** `baseURL`，
  而手上有多家生图渠道。此插件在 DSH 进程内起一个 `127.0.0.1` 端点，按模型名前缀路由。
  随 DSH 启停，不注册服务、不写计划任务、无常驻后台进程。

- **desktop-locale-fix** —— 0.1.5 的通知文案按 `runtime.locale` 取，而该 facade 只在
  `settings/updated` 事件里被更新。语言偏好**被加载**时不产生该事件，于是重启后通知
  一律英文，直到偏好发生一次真实变更。此插件在启动后主动把偏好推给 facade。

- **fairy-theme** —— 官方主题变量 `--dsw-alias-*` 有 79 个，被引用次数极度不均
  （高频的 `label-tertiary` 被引用 197 次，小众强调色只有 7 次）。最初只改 13 个变量时
  "代码执行了但界面纹丝不动"。这个坑的完整复盘写在
  [插件 README](plugins/dsh-fairy-theme/README.md) 里 —— **判定 UI 改动是否生效，
  必须统计它实际影响的渲染表面积**，而不只是确认代码跑了。

---

## License

代码：[MIT](LICENSE)。素材不在覆盖范围内，见上文。
