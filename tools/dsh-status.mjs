#!/usr/bin/env node
/**
 * dsh-status.mjs — 上下文压缩 / token 用量状态速查
 *
 * 数据来源：~/.dsh/storages/session_projcache/sessions/<session>.json
 * 关键行：
 *   agentPreset      本会话实际使用的 preset（决定压缩阈值）
 *   tokenUsage       累计输入/输出/缓存命中（精确值，非估算）
 *   contextPressure  当前每步上下文大小 + 上下文窗口
 *   contextBreakdown system / tools / message 三分
 *   sessionStats     轮数、步数、耗时、解码速度
 *
 * 昨日基线（standard preset，198 步）：
 *   uncached 596,229 + cache 43,872,768 = 44,468,997 输入
 *   输出 256,081 / 缓存命中 98.66% / 平均 224,591 输入每步 / 上下文 73,490
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

const DIR = path.join(os.homedir(), ".dsh", "storages", "session_projcache", "sessions");
const BASELINE_AVG = 224591;
const BASELINE_HIT = 98.66;

const fmt = (n) => (n ?? 0).toLocaleString("en-US");
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(2) : "0.00");

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"))
  .map((f) => ({ f, mtime: fs.statSync(path.join(DIR, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

console.log(`=== 全部会话（按最近活动排序，${files.length} 个）===`);
const rows = [];
for (const { f, mtime } of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch { continue; }
  const r = j.record?.rows ?? {};
  const tu = r.tokenUsage?.val?.totals ?? {};
  const inTok = (tu.uncachedInputTokens ?? 0) + (tu.cacheReadTokens ?? 0);
  const st = r.sessionStats?.val ?? {};
  const cp = r.contextPressure?.val ?? {};
  rows.push({ f, mtime, preset: r.agentPreset?.val ?? "?", inTok, tu, st, cp,
    msgs: r.contextBreakdown?.val ?? {}, model: r.modelSelection?.val?.lastUsed ?? null });
}

for (const x of rows.slice(0, 10)) {
  const hit = pct(x.tu.cacheReadTokens ?? 0, x.inTok);
  console.log(
    `  ${new Date(x.mtime).toISOString().slice(5, 16).replace("T", " ")}  ` +
    `preset=${String(x.preset).padEnd(15)} 轮=${String(x.st?.turns ?? "?").padStart(3)} 步=${String(x.st?.steps ?? "?").padStart(4)} ` +
    `输入=${fmt(x.inTok).padStart(12)} 命中=${hit.padStart(6)}% ctx=${fmt(x.cp.pressureTokens)}`
  );
}

const cur = rows[0];
if (!cur) { console.log("无会话数据"); process.exit(0); }

console.log(`\n=== 当前会话明细：${cur.f} ===`);
console.log(`  最后活动     : ${new Date(cur.mtime).toLocaleString("zh-CN")}`);
console.log(`  agentPreset  : ${cur.preset}   ${cur.preset === "standard-tuned" ? "★ 新配置已生效" : "（旧配置：阈值 80 万）"}`);
console.log(`  模型         : ${JSON.stringify(cur.model)}`);
console.log(`  轮 / 步      : ${cur.st?.turns} / ${cur.st?.steps}`);
console.log(`  输入 未缓存  : ${fmt(cur.tu.uncachedInputTokens)}`);
console.log(`  输入 缓存命中: ${fmt(cur.tu.cacheReadTokens)}`);
console.log(`  输入 合计    : ${fmt(cur.inTok)}`);
console.log(`  缓存命中率   : ${pct(cur.tu.cacheReadTokens ?? 0, cur.inTok)}%`);
console.log(`  输出         : ${fmt(cur.tu.outputTokens)}`);
console.log(`\n  contextPressure : ${JSON.stringify(cur.cp)}`);
console.log(`  contextBreakdown: ${JSON.stringify(cur.msgs)}`);
console.log(`  sessionStats    : ${JSON.stringify(cur.st)}`);

// ── 真实压缩证据：读追加式会话事件日志（多帧 zstd），数 compaction/* 与「被剪裁替换」的工具结果 ──
function sessionEvidence(sessionFile) {
  const id = sessionFile.replace(/^session-/, "").replace(/\.json$/, "");
  const SESS = path.join(os.homedir(), ".dsh", "sessions");
  const find = (d, depth) => {
    if (depth > 3) return null;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        const r = find(p, depth + 1);
        if (r) return r;
      // 0.1.5 起事件日志改名 session.v3.jsonl.zstd（会话格式 v3），旧名兼容
      } else if (/^session(\.v\d+)?\.jsonl\.zstd$/.test(e.name) && p.includes(id)) return p;
    }
    return null;
  };
  const f = find(SESS, 0);
  if (!f) return { found: false };

  const buf = fs.readFileSync(f);
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const parts = [];
  for (let at = buf.indexOf(MAGIC); at !== -1; at = buf.indexOf(MAGIC, at + 1)) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(at))); } catch { /* 伪 magic */ }
  }
  const ev = [];
  for (const l of Buffer.concat(parts).toString("utf8").split("\n")) {
    const s = l.trim();
    if (!s) continue;
    try { ev.push(JSON.parse(s)); } catch { /* 半行 */ }
  }
  const of = (p) => ev.filter((e) => String(e.type).startsWith(p));
  const summary = of("compaction/summary").at(-1);
  let pruned = 0;
  const saw = new Set();
  for (const e of ev) {
    // 真判据：剪裁替换是 surfaceOp.op === "replace"（普通 tool/result 也带 sourceEventSeqs）
    if (e.type === "tool/result" && e.surfaceOp?.op === "replace") {
      const key = JSON.stringify(e.surfaceOp);
      if (!saw.has(key)) { saw.add(key); pruned += 1; }
    }
  }
  // ⚠️ 2026-09-15：dsh-retrace 借用**官方** `compaction/prune` 类型写审计事件
  //   （lib/marker-carrier.js: AUDIT_EVENT_TYPE = 'compaction/prune'，
  //     data = {shadowedRange, shadowedSeqs, shadowedTokenCount} —— 与官方词表**同名同形**）。
  //   ⇒ 直接用 of("compaction/prune").length 会把 retrace 的审计误报成「剪裁次数」。
  //   实测判据（2026-09-15，925 条纯官方样本）：官方剪裁事件 **不被任何事件引用**；
  //   retrace 的审计事件会被紧随的 `user/message` 载体以 `sourceEventSeqs[0]` 引用
  //   （lib/adapter/dsh-writer.js: carrier 的 sourceEventSeqs = [auditSeq, ...shadowed]）。
  const referencedSeqs = new Set();
  for (const e of ev) {
    if (Array.isArray(e.sourceEventSeqs)) for (const s of e.sourceEventSeqs) referencedSeqs.add(s);
  }
  const pruneAll = of("compaction/prune");
  const pruneOfficial = pruneAll.filter((e) => !referencedSeqs.has(e.seq));
  const pruneRetrace = pruneAll.length - pruneOfficial.length;
  return {
    found: true, file: f, events: ev.length,
    start: of("compaction/start").length,
    end: of("compaction/end").length,
    prune: pruneOfficial.length,
    pruneRetrace,
    pruneRaw: pruneAll.length,
    summary: of("compaction/summary").length,
    prunedResults: pruned,
    lastSummaryChars: summary ? JSON.stringify(summary.data).length : 0,
    marker: ev.some((e) => e.type === "tool/result" && JSON.stringify(e.data ?? {}).includes("tool result middle pruned")),
  };
}

const win = cur.cp.contextWindow ?? 0;
const thr = cur.preset === "standard-tuned" ? 0.2 : 0.8;
console.log(`\n=== 压缩状态判定 ===`);
console.log(`  上下文窗口   : ${fmt(win)}`);
console.log(`  触发阈值     : ${fmt(Math.floor(win * thr))}  (${cur.preset} × ${thr})`);
console.log(`  当前上下文   : ${fmt(cur.cp.pressureTokens)}  = 窗口的 ${(win ? ((cur.cp.pressureTokens / win) * 100).toFixed(1) : "?")}%`);
console.log(`  距触发还剩   : ${fmt(Math.floor(win * thr) - (cur.cp.pressureTokens ?? 0))}`);

const ev = sessionEvidence(cur.f);
if (!ev.found) {
  console.log(`  自动压缩     : 找不到会话事件日志，无法判定`);
} else {
  console.log(`  自动压缩     : ${ev.start > 0 ? `已触发 ${ev.start} 次（summary ${ev.summary} 次）` : "未触发（会话事件日志里 0 条 compaction/start）"}`);
  console.log(`  工具输出剪裁 : ${ev.prune > 0 ? `${ev.prune} 次 compaction/prune，${ev.prunedResults} 条工具结果被替换` : "0 次（低于阈值时剪裁器根本不会被调用）"}`);
  if (ev.pruneRetrace > 0) {
    console.log(`    ↳ 其中 retrace 审计事件已排除 ${ev.pruneRetrace} 条（原始 compaction/prune 共 ${ev.pruneRaw} 条）`);
  }
  console.log(`  事件日志     : ${fmt(ev.events)} 条事件  ${ev.file}`);
}

const avg = cur.st?.steps ? Math.round(cur.inTok / cur.st.steps) : 0;
console.log(`\n=== 与昨日基线对比（standard / 198 步）===`);
console.log(`  平均输入每步 : ${fmt(avg)}   vs 基线 ${fmt(BASELINE_AVG)}   ${BASELINE_AVG ? (avg / BASELINE_AVG > 1 ? "↑" : "↓") + Math.abs(((avg - BASELINE_AVG) / BASELINE_AVG) * 100).toFixed(1) + "%" : ""}`);
console.log(`  缓存命中率   : ${pct(cur.tu.cacheReadTokens ?? 0, cur.inTok)}%   vs 基线 ${BASELINE_HIT}%`);
