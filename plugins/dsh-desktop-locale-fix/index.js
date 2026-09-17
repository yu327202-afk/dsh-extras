/**
 * dsh-desktop-locale-fix —— 修复 DSH Desktop 0.1.5 的通知语言回落缺陷
 *
 * 缺陷链路（读 lib/ 出厂代码取证）：
 *   1. 通知文案表按 `runtime.locale` 取：notifications-D1xVgWt2.js 里
 *      `NOTIFICATION_COPY[runtime.locale]['turn-completed']`
 *   2. 这里的 runtime 是 host-process-entry.js 提供的 `desktopRuntime` 服务，
 *      真身是 profile-channel-admission-CVuyDpHt.js 的 `createHostRuntime(rpc, snapshot)`
 *   3. 该 facade 的 locale：`let locale = snapshot.locale`（原生启动快照，原生
 *      ElectronDesktopRuntime 的字段默认值是 "en"），**只有** `setLocalePreference()` 会改它，
 *      而它只有两个调用者：
 *        - 桌面壳插件 `ctx.on('settings/updated', ns => ns==='locale' && setLocalePreference(...))`
 *        - 没人调用的启动路径（`schedule`/`mountScheduled` 只把偏好推给原生侧，不写回 facade）
 *   ⇒ 语言偏好「被加载」时不产生 settings/updated 事件，facade 就永远停在 "en"，
 *     于是重启后系统通知一律英文，直到语言偏好发生一次真实变更。
 *
 * 本插件做的事：启动后主动把「当前语言偏好」推给 facade，并在偏好变化时继续同步。
 * 纯用户态，不改 app.asar；卸载方式：从 profile 的 dsh.profile.bundles 里去掉本包名并重启。
 */

export const name = "desktop-locale-fix";

/** 只依赖 native facade；settings 用可选方式访问，避免因命名空间注册晚而拖累插件加载。 */
export const inject = ["desktopRuntime"];

const NAMESPACE = "locale";
const LOCALE_IDS = ["zh", "en"];

/** 兜底语言：settings 里没有有效偏好时使用（本机用户要求中文）。 */
const DEFAULT_PREFERENCE = "zh";

export function apply(ctx, config = {}) {
  const fallback = LOCALE_IDS.includes(config?.preference) ? config.preference : DEFAULT_PREFERENCE;

  const log = (message) => {
    try {
      ctx.logger.info(`[locale-fix] ${message}`);
    } catch {
      process.stderr.write(`[locale-fix] ${message}\n`);
    }
  };

  /** 读 settings 里已解析的偏好；命名空间未注册/未就绪时返回 undefined。 */
  const readPreference = () => {
    let value;
    try {
      value = typeof ctx.settings?.get === "function" ? ctx.settings.get(NAMESPACE) : undefined;
    } catch {
      value = undefined;
    }
    const preference = value !== null && typeof value === "object" ? value.preference : undefined;
    return LOCALE_IDS.includes(preference) ? preference : undefined;
  };

  let pushed;

  const push = (reason) => {
    const preference = readPreference();
    const target = preference ?? fallback;
    try {
      ctx.desktopRuntime.setLocalePreference(target);
      pushed = target;
      log(`push(${reason}): settings=${preference ?? "(未设置)"} → setLocalePreference('${target}')`);
    } catch (cause) {
      log(`push(${reason}) 失败: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  // 启动即推一次；再用退避重试覆盖「settings 命名空间比本插件注册得晚」和「RPC 尚未就绪」两种情况。
  push("apply");
  for (const delay of [1000, 3000, 8000, 20000]) {
    const timer = setTimeout(() => {
      if (readPreference() !== pushed) push(`retry+${delay}ms`);
    }, delay);
    timer.unref?.();
  }

  // 偏好真实变化时同步（桌面壳插件自己也会处理，这里是幂等兜底）。
  ctx.on("settings/updated", (namespace, next) => {
    if (namespace !== NAMESPACE) return;
    log(`settings/updated('${NAMESPACE}') = ${JSON.stringify(next)}`);
    push("event");
  });
}
