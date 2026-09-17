# dsh-desktop-locale-fix

修复 DSH Desktop **0.1.5-rc.1** 上「语言偏好设了中文，重启后系统通知又变回英文」的缺陷。

纯用户态修复，**不改 `app.asar`**。

---

## 缺陷链路（读出厂代码取证，不是猜的）

1. 通知文案表按 `runtime.locale` 取：
   `NOTIFICATION_COPY[runtime.locale]['turn-completed']`
2. 这里的 `runtime` 是 `desktopRuntime` 服务，真身是 `createHostRuntime(rpc, snapshot)`
3. 该 facade 的 locale 是 `let locale = snapshot.locale` —— 来自**原生启动快照**，
   而原生 `ElectronDesktopRuntime` 的字段默认值是 `"en"`
4. 能改它的**只有** `setLocalePreference()`，它只有两个调用者：
   - 桌面壳插件：`ctx.on('settings/updated', ns => ns === 'locale' && setLocalePreference(...))`
   - 启动路径：只把偏好推给原生侧，**不写回 facade**

⇒ 语言偏好**被加载**时不产生 `settings/updated` 事件，facade 就永远停在 `"en"`。
于是每次重启后通知一律英文，直到你**手动改一次**语言偏好（触发那个事件）才变回中文。

## 本插件做什么

启动后主动把「当前已解析的语言偏好」推给 facade，并在偏好真实变化时继续同步。
这样即使没有任何 `settings/updated` 事件，locale 也是对的。

- 启动即推一次
- 再用 `1s / 3s / 8s / 20s` 退避重试，覆盖「settings 命名空间注册晚于本插件」与「RPC 尚未就绪」
- 每次重试前先比对当前值，**幂等**，不做无用写入
- `settings/updated` 事件仍照常响应（与桌面壳插件重复也安全）

---

## 安装

```powershell
dsh plugin --profile desktop add link:C:/dsh-desktop-locale-fix
```

装完**重启 DSH**。

## 验证是否生效

插件每次推送都会写日志。重启后开一次通知，然后查主进程日志里有没有：

```
[locale-fix] push(apply): settings=zh → setLocalePreference('zh')
```

⚠️ 注意：`console.log` 在 Electron 主进程**不落盘**，所以本插件走 `ctx.logger.info`。
如果完全看不到这行，先确认插件真的加载了（`dsh plugin --profile desktop list`），
而不是先怀疑 locale 逻辑。

## 配置

兜底语言默认 `zh`。当前 settings 里没有有效偏好（不是 `zh`/`en`）时用它：

```yaml
# cordis.patch.yml 的 config 段
- insert:
    - id: dsh-desktop-locale-fix
      name: dsh-desktop-locale-fix
      config:
        preference: en    # 改成 en 可让兜底值为英文
```

## 卸载 / 回滚

```powershell
dsh plugin --profile desktop remove dsh-desktop-locale-fix
```

再重启。卸载后行为退回原状（重启后通知回落英文，直到手动改一次偏好）。

---

## 这个插件的意义

它不是"打个补丁让用户爽"，而是**一个静默失效的加载路径**的取证记录：

> 语言偏好**被加载**了，但那条加载路径不写回运行时 facade。

同类陷阱的通用判据是：**"配置被读到了" ≠ "配置产生了作用"**。
排查这种问题时，要顺着"谁会调用那个 setter"去数调用者，
而不是停在"配置项确实读进来了"。
