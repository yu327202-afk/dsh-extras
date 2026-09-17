#!/usr/bin/env node
/**
 * dsh-session-events.mjs — 读 DSH 的追加式会话事件日志（session.jsonl.zstd），
 * 给出压缩/剪裁的现场证据 + 每步请求 token 序列（用于看上下文锯齿）。
 *
 * 用法:
 *   node dsh-session-events.mjs               # 本工作区最新会话
 *   node dsh-session-events.mjs <子串>        # 指定会话 id 子串
 *   node dsh-session-events.mjs --all         # 本工作区全部会话的压缩事件汇总
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable, Writable } from "node:stream";

const ROOT = path.join(os.homedir(), ".dsh", "sessions", "--F-DSH~0020desktop-DSH_Workspace--");
const PRUNE_MARKER = "[... tool result middle pruned ...]";
const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : String(n ?? "?"));

/** 取 tool/result 事件的可见文本：data.message.content[].content[].text */
const textOf = (e) =>
  (e.data?.message?.content ?? [])
    .flatMap((b) => b.content ?? [])
    .map((t) => t.text ?? "")
    .join("");

/**
 * zstd 解压。日志按帧追加写，而 Node 的 zstd 解压器只吃第一帧，
 * 因此扫描 zstd magic（28 B5 2F FD）逐帧解；解不开的候选偏移直接跳过。
 */
function readZstd(file) {
  const buf = fs.readFileSync(file);
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const parts = [];
  const seen = new Set();
  let at = buf.indexOf(MAGIC);
  let frames = 0;
  while (at !== -1) {
    if (!seen.has(at)) {
      seen.add(at);
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(at)));
        frames += 1;
      } catch {
        /* 伪 magic（出现在压缩载荷里）→ 跳过 */
      }
    }
    at = buf.indexOf(MAGIC, at + 1);
  }
  return { text: Buffer.concat(parts).toString("utf8"), frames };
}

function parseEvents(text) {
  const out = [];
  for (const l of text.split("\n")) {
    const s = l.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* 半行/损坏行忽略 */
    }
  }
  return out;
}

function sessions() {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      // 0.1.5 起事件日志改名 session.v3.jsonl.zstd（会话格式 v3），旧名兼容
      const dir = path.join(ROOT, d.name);
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => /^session(\.v\d+)?\.jsonl\.zstd$/.test(n)); } catch { }
      const f = names.length ? path.join(dir, names[0]) : path.join(dir, "session.jsonl.zstd");
      return { id: d.name, file: f, mtime: fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0 };
    })
    .filter((x) => x.mtime > 0)
    .sort((a, b) => b.mtime - a.mtime);
}

const args = process.argv.slice(2);
const all = args.includes("--all");
const needle = args.find((a) => !a.startsWith("--"));
const list = sessions();
const pick = all ? list : [needle ? list.find((s) => s.id.includes(needle)) : list[0]].filter(Boolean);

if (pick.length === 0) {
  console.log(`未找到会话（${ROOT}）`);
  process.exit(0);
}

for (const s of pick) {
  let events;
  let frames = 0;
  try {
    const r = readZstd(s.file);
    frames = r.frames;
    events = parseEvents(r.text);
  } catch (e) {
    console.log(`\n### ${s.id}\n  解压失败: ${e.message}`);
    continue;
  }

  const counts = new Map();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);

  console.log(`\n### ${s.id}`);
  console.log(`  文件: ${s.file}`);
  console.log(`  zstd 帧: ${fmt(frames)}`);
  console.log(`  事件数: ${fmt(events.length)}   最早: ${events[0]?.time ?? "?"}   最晚: ${events.at(-1)?.time ?? "?"}`);

  const compactionTypes = [...counts.keys()].filter((t) => t.includes("compaction") || t.includes("command"));
  if (compactionTypes.length === 0) {
    console.log("  压缩相关事件: 无（该会话从未压缩/剪裁过）");
  } else {
    console.log("  压缩相关事件:");
    for (const t of compactionTypes.sort()) console.log(`    ${String(counts.get(t)).padStart(5)}  ${t}`);
  }

  if (!all) {
    // 全量事件类型直方图（帮助确认 schema）
    console.log("  全部事件类型:");
    for (const [t, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(5)}  ${t}`);
    }

    // 请求级上下文快照：逐请求压力序列（看锯齿的关键）
    const reqs = events.filter((e) => String(e.type).startsWith("request/"));
    if (reqs.length) {
      console.log(`  请求级事件: ${reqs.length} 条`);
      if (args.includes("--requests")) {
        console.log(`  样例外层字段: ${JSON.stringify(Object.keys(reqs[0]))}`);
        console.log(`  样例完整内容:\n${JSON.stringify(reqs[0], null, 1).slice(0, 3000)}`);
        console.log("  逐请求数值序列:");
        for (const e of reqs) {
          const flat = {};
          const walk = (v, p) => {
            if (v && typeof v === "object") {
              for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
            } else if (typeof v === "number" && /token|chars|pressure/i.test(p)) flat[p] = v;
          };
          walk(e.data, "");
          console.log(`    seq=${e.seq} step=${e.data?.step ?? "?"} ${JSON.stringify(flat)}`);
        }
      } else {
        console.log("    （加 --requests 看逐请求 token 序列）");
      }
    }

    // ── 剪裁参数落地验证：逐个 tool/result 事件量它的实际字符数 ──
    if (args.includes("--prunes")) {
      const results2 = events.filter((e) => e.type === "tool/result");
      console.log(`  tool/result 事件逐个量尺（共 ${results2.length} 条，REPLACE = 被剪裁替换）:`);
      console.log("      seq  动作      字符数   头 40 字符");
      for (const e of results2) {
        const text = textOf(e);
        const chars = [...text].length;
        const kind = e.surfaceOp?.op === "replace" ? "REPLACE" : "append";
        console.log(
          `  ${String(e.seq).padStart(7)}  ${kind.padEnd(8)}  ${String(chars).padStart(7)}  ${String(JSON.stringify(e.data?.message ?? {}).length).padStart(7)}  ${text.slice(0, 34).replace(/\n/g, "\\n")}`
        );
      }
      const repl = results2.filter((e) => e.surfaceOp?.op === "replace");
      const lens = [...new Set(repl.map((e) => [...textOf(e)].length))].sort((a, b) => a - b);
      console.log(`  替换件字符数取值集合: ${JSON.stringify(lens)}`);
      console.log(`  ⇒ tuned 预算应为 head 2000 + marker 39 + tail 500 = 2539；出厂默认是 4096+39+1024 = 5159`);
    }

    // 压缩/剪裁事件明细
    const detail = events.filter((e) => String(e.type).startsWith("compaction/"));
    if (detail.length) {
      console.log("  压缩事件明细:");
      for (const e of detail.slice(0, 40)) {
        const d = JSON.stringify(e.data ?? {});
        console.log(`    [${e.time ?? "?"}] ${e.type}  ${d.length > 300 ? d.slice(0, 300) + "…" : d}`);
      }
    }

    // 被剪裁替换过的工具结果（真判据：surfaceOp.op === "replace"）
    const replaced = events.filter((e) => e.type === "tool/result" && e.surfaceOp?.op === "replace");
    const pruned = counts.get("compaction/prune") ?? 0;
    console.log(`  剪裁证据: compaction/prune ${pruned} 条，被替换的 tool/result ${replaced.length} 条`);
    const markerOnly = events.filter((e) => JSON.stringify(e).includes(PRUNE_MARKER)).length;
    console.log(`  （原始 key 的标记字符串出现在 ${markerOnly} 条事件里，含本脚本自身输出，仅作参考）`);

    // 每步请求 token 序列（找 usage / tokens 字段）
    const withUsage = events.filter((e) =>
      JSON.stringify(e.data ?? {}).match(/"(inputTokens|totalTokens|promptTokens|estimatedTokens)"/)
    );
    if (withUsage.length) {
      console.log(`  带 token 记数的事件: ${withUsage.length} 条，样例字段:`);
      console.log(`    ${JSON.stringify(withUsage.at(-1)).slice(0, 400)}`);
    } else {
      console.log("  未在事件日志中找到逐请求 token 记数（锯齿需靠 dsh-status 的 contextPressure 采样）");
    }
  }
}
