#!/usr/bin/env node
/**
 * verify-live-contract.mjs —— 「装好了≠生效了」的契约守门人。
 *
 * 背景：2026-09-16 首次安装后重启，界面毫无变化。事后定位到两条硬契约：
 *   1. host 侧 index.js 必须 `export const inject = [...]`
 *      —— 缺它时 cordis 根本不调用 apply()，插件静默躺在层栈里
 *   2. client 侧 factory 的返回值就是 exports（materialize 里
 *      `exports: registered(...)`），所以返回裸对象合法，但必须含 apply
 *
 * 本脚本把这两条固化成断言，并顺带核对「已装 profile 里的实际文件」，
 * 避免以后又出现「测试全绿但界面上什么都没有」。
 */
import fs from 'node:fs';
import path from 'node:path';

const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// 仓库根 = 本脚本所在目录的上一级（可移植，不含任何绝对路径）。
// decodeURIComponent 必需：路径含空格时 url.pathname 会把空格编码成 %20。
const SELF_DIR = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
const REPO = path.resolve(SELF_DIR, '..');
// 已装 profile 目录：可用 DSH_PROFILE_DIR 覆盖，默认按 DSH_HOME 推导。
// 这一步查不到时只跳过「已装 profile」那一组断言，不影响仓库自身的契约检查。
const DSH_HOME = process.env.DSH_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
const PROFILE = process.env.DSH_PROFILE_DIR
  || path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-fairy-theme');

console.log('=== 活契约验证（host inject + client exports）===\n');

// 「已装 profile」是可选断言：新克隆的仓库还没装插件时不该因此判失败。
const targets = [['仓库', REPO]];
if (fs.existsSync(PROFILE)) targets.push(['已装 profile', PROFILE]);
else console.log(`— 已装 profile：不存在（${PROFILE}），跳过该组断言\n`);

for (const [label, dir] of targets) {
  console.log(`— ${label}：${dir}`);

  // ── host 侧
  const hostPath = path.join(dir, 'lib', 'index.js');
  const host = fs.existsSync(hostPath) ? fs.readFileSync(hostPath, 'utf8') : '';
  check(`${label} host 导出 name`, /export\s+const\s+name\s*=/.test(host));
  check(`${label} host 导出 inject`, /export\s+const\s+inject\s*=\s*\[/.test(host),
    /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/.exec(host)?.[1]?.trim() ?? '★ 缺失 → apply 不会被调用');
  check(`${label} host 导出 apply`, /export\s+function\s+apply\s*\(|export\s+const\s+apply\s*=/.test(host));

  // ── client 侧
  const clientPath = path.join(dir, 'lib', 'client.js');
  const client = fs.existsSync(clientPath) ? fs.readFileSync(clientPath, 'utf8') : '';
  check(`${label} client 走 __ModuleLoader__.load`, client.includes('window.__ModuleLoader__.load('));
  check(`${label} client factory 返回 apply`, /return\s*\{[^}]*\bapply\b/.test(client),
    'materialize 取 factory 返回值作为 exports');
  check(`${label} client 未用顶层 ESM 语法`,
    !/^\s*(import|export)\s/m.test(client),
    '合并捆绑要求纯 CJS 形态');
  check(`${label} client 无 eventSource 死依赖`,
    !/^\s*[^*/]*\bbinding\.eventSource\b/m.test(client), '0.1.5 不存在该 API');

  // ── package.json
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    check(`${label} dsh.client.platform=web`, pkg.dsh?.client?.platform === 'web');
    check(`${label} dsh.bundle.patch 已声明`, typeof pkg.dsh?.bundle?.patch === 'string');
    check(`${label} exports["./client"] 指向真实文件`,
      typeof pkg.exports?.['./client'] === 'string' && fs.existsSync(path.join(dir, pkg.exports['./client'])));
  }
  console.log();
}

// ── 两处哈希一致（仅当本机确实装了该插件时才有意义；未安装则整段跳过）
if (!fs.existsSync(PROFILE)) {
  console.log(`— 仓库 ↔ profile 一致性：跳过（未找到已安装副本 ${PROFILE}）`);
  console.log(`  如需检查，设置 DSH_PROFILE_DIR 指向已装目录。`);
} else {
  console.log('— 仓库 ↔ profile 一致性');
  for (const rel of ['lib/index.js', 'lib/client.js', 'package.json']) {
    const a = path.join(REPO, rel), b = path.join(PROFILE, rel);
    if (!fs.existsSync(a) || !fs.existsSync(b)) { check(`${rel} 两处都在`, false); continue; }
    const same = fs.readFileSync(a).equals(fs.readFileSync(b));
    check(`${rel} 内容一致`, same);
  }
}

console.log(`\n=== 结果：${results.filter((r) => r.ok).length}/${results.length} PASS，${failures} FAIL ===`);
process.exit(failures === 0 ? 0 : 1);
