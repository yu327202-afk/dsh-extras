# 素材政策 · Why `assets/` is not in this repository

**本仓库只分发代码，不分发美术素材。** 这是有意为之，不是遗漏。

## 为什么

| 素材 | 实际来源 | 权利状态 |
|---|---|---|
| Fairy 形象（动画帧、`fairy.svg`、头像） | 社区作品 `pi-fairy-animation` / `FairyAvatar` | **角色版权属米哈游《绝区零》**，社区作品本身亦未声明可再分发许可 |
| 44 段事件语音 | 社区作品 `pi-fairy`，文件经用户提供的 QQ 群文件流转 | 来源链路不可追溯，**无任何授权声明** |

这些文件属于第三方美术资源，权利人不明或明确属于商业公司。
把它们放进公开仓库属于再分发他人版权素材，不符合 GitHub
[Acceptable Use Policies 第 3 节](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies#3-intellectual-property-authenticity-and-private-information)
（不得上传侵犯他人专利、商标、著作权等专有权利的内容）。

因此：**代码用 MIT 开源，素材由使用者自行准备。** 代码与素材的边界在文件系统层面
就是清晰的 —— `assets/` 目录整个被 `.gitignore` 排除。

## 没有素材会怎样

插件**不会崩**，只是没有视觉与音效，降级为纯主题：

- 缺帧图 / SVG / 头像 → 浮动 Fairy 不渲染，HDD 配色仍然生效
- 缺语音 → 事件音效静默跳过
- `test/selftest.mjs` 里 6 项素材检查自动降级为 `[SKIP]`，不判失败（30/30 PASS）

这是设计目标之一：**素材是可选的装饰，不是运行前提。**

## 想自己补齐素材

在插件根目录建 `assets/`，按下面的结构放文件：

```
assets/
├── fairy.svg                    # 矢量形象（CSS 动效驱动）
├── avatar-circle.png            # 圆形头像，4096×4096
├── avatar-square.png            # 方形头像，4096×4096
├── frames/
│   ├── dark/000.png … 119.png   # 深色模式动画帧，256×256，120 张无缺号
│   └── light/000.png … 119.png  # 浅色模式动画帧，同上
└── sounds/                      # 44 段 .wav 事件音效
```

放好后跑 `node test/selftest.mjs`，素材检查会自动从 SKIP 变为实际断言
（本机实测：有素材时 **36/36 PASS**）。

## 请自行确认你有权使用

补齐素材属于**你本人**的再分发/使用行为。请自行确认你对该素材拥有相应权利，
或仅在本机私人使用。本项目不附带、不担保任何素材授权。

如果权利人提出异议，本仓库需要移除的只有**代码中对素材的引用**，
不涉及任何素材文件的删除。
