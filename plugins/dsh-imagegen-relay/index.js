/**
 * dsh-imagegen-relay —— 把多个生图渠道聚合成一个 OpenAI 兼容端点
 *
 * 为什么需要它：
 *   dsh-image-gen 插件的 `openai-compat` provider 只能配置【一个】baseURL，
 *   而用户手上有多家生图渠道。本插件把所有渠道聚合成一个
 *   `http://127.0.0.1:<port>/v1`，插件端只需填这一个地址即可覆盖全部渠道。
 *
 * 形态（用户要求「随插件启用、不用不占资源」）：
 *   本插件由 DSH 的插件树加载，随 DSH 启动而启动、随 DSH 退出而消失，
 *   不注册为 Windows 服务、不写计划任务、无常驻后台进程。
 *   用 ctx.effect() 托管 HTTP server，卸载插件时自动关闭监听。
 *
 * ★ 加新渠道：改 `~/.dsh/imagegen-relay.channels.json` 即可。
 *   该文件【默认自动重载】（按 mtime 检查，无需重启 DSH）。
 *   若文件不存在，则使用下方 DEFAULT_CHANNELS 并在首次启动时落盘一份。
 *
 * 路由规则（请求体 model 字段）：
 *   "渠道/模型"  显式指定，如 myprovider/gpt-image-2
 *   "模型"       按渠道顺序回落（同名模型取第一家）
 *
 * 端点：
 *   GET  /health                 健康检查（含当前渠道）
 *   GET  /v1/models              聚合模型清单（带渠道前缀）
 *   POST /v1/images/generations  按 model 路由到对应上游
 *   POST /v1/reload              手动重载渠道配置
 *   其他 /v1/*                   转发到默认渠道（第一家）
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "imagegen-relay";
/** credentials 是内置服务（dsh-image-gen 亦注入它）。 */
export const inject = ["credentials"];

const DSH_HOME = path.join(os.homedir(), ".dsh");
const CHANNELS_FILE = path.join(DSH_HOME, "imagegen-relay.channels.json");
const STATUS_FILE = path.join(DSH_HOME, "imagegen-relay.status.json");

/**
 * 内置默认渠道示例。
 *
 * 这里**故意只放占位条目**，不写任何真实第三方中转站。
 * 原因有两条：
 *   1) 公开仓库里罗列具体服务商形同广告，且那些地址随时会失效、
 *      留在默认值里只会误导使用者（详见 GitHub AUP 第 10 节对推广内容的限制）。
 *   2) 真实渠道与凭据属于**本机私有配置**，不该进任何仓库。
 *
 * 首次启动时本数组会落盘为 CHANNELS_FILE 作为模板，之后一律以文件为准。
 * 按同结构照抄一条填上你自己的渠道即可；也可以直接删掉占位项。
 *
 * 字段说明：
 *   id            渠道标识，用在模型名前缀里（只允许字母数字与 . _ -，不能以符号开头）
 *   label         显示名（仅用于日志/健康检查）
 *   base          上游 OpenAI 兼容根地址（到 /v1 为止，末尾不要斜杠）
 *   credentialRef .credentials.yaml 里 refs 段的键名（如 P_MY_PROVIDER）
 *   models        该渠道支持的模型名数组（裸名，不带前缀）
 */
const DEFAULT_CHANNELS = [
  {
    id: "example",
    label: "示例渠道（请替换）",
    base: "https://api.example.com/v1",
    credentialRef: "P_EXAMPLE",
    models: ["gpt-image-2", "gpt-image-2.5"],
  },
];

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "content-encoding",
  "transfer-encoding",
]);

const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** 生成类请求的上游超时。生图较慢，给足时间。 */
const UPSTREAM_TIMEOUT_MS = 240000;

/**
 * 校验并规范化渠道数组。
 * 加渠道写错时给出明确报错，而不是运行时神秘失败。
 */
function normalizeChannels(raw) {
  if (!Array.isArray(raw)) throw new Error("渠道配置必须是数组");
  const out = [];
  const seen = new Set();
  for (const [i, c] of raw.entries()) {
    const at = `第 ${i + 1} 条`;
    if (typeof c !== "object" || c === null) throw new Error(`${at} 不是对象`);
    const id = String(c.id ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new Error(`${at} 的 id "${c.id}" 非法（只允许字母数字和 . _ -，且不能以符号开头）`);
    }
    if (seen.has(id)) throw new Error(`${at} 的 id "${id}" 重复`);
    seen.add(id);
    const base = String(c.base ?? "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(base)) throw new Error(`${at}(${id}) 的 base 必须是 http(s) 地址`);
    const credentialRef = String(c.credentialRef ?? "").trim();
    if (credentialRef.length === 0) throw new Error(`${at}(${id}) 缺少 credentialRef`);
    const models = (Array.isArray(c.models) ? c.models : []).map((m) => String(m).trim()).filter(Boolean);
    if (models.length === 0) throw new Error(`${at}(${id}) 的 models 不能为空`);
    out.push({ id, label: String(c.label ?? id), base, credentialRef, models });
  }
  if (out.length === 0) throw new Error("渠道配置为空");
  return out;
}

/** 读取渠道配置文件；不存在时落盘默认值。返回 {channels, source, error} */
function loadChannels(file = CHANNELS_FILE) {
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, JSON.stringify(DEFAULT_CHANNELS, null, 2) + "\n", "utf8");
    } catch {
      /* 写不了就用内存默认值 */
    }
    return { channels: normalizeChannels(DEFAULT_CHANNELS), source: "内置默认（已尝试落盘）" };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const raw = Array.isArray(parsed) ? parsed : parsed?.channels;
    return { channels: normalizeChannels(raw), source: file };
  } catch (error) {
    return {
      channels: normalizeChannels(DEFAULT_CHANNELS),
      source: `内置默认（${file} 读取失败）`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 解析 "渠道/模型" 前缀；无前缀时按模型名查表回落。 */
function buildRouter(channels) {
  const index = new Map();
  for (const c of channels) for (const m of c.models) if (!index.has(m)) index.set(m, c.id);
  const byId = new Map(channels.map((c) => [c.id, c]));
  return (rawModel, log) => {
    const raw = String(rawModel ?? "").trim();
    const slash = raw.indexOf("/");
    if (slash > 0) {
      const wanted = raw.slice(0, slash);
      const ch = byId.get(wanted);
      // 明确写了渠道前缀却不认识：报错，不静默转发到别的上游。
      if (!ch) {
        return {
          error:
            `未知渠道 "${wanted}"。可用渠道: ${channels.map((c) => c.id).join(", ")}` +
            `（模型写法: 渠道/模型，例如 ${channels[0].id}/${channels[0].models[0]}）`,
        };
      }
      return { channel: ch, model: raw.slice(slash + 1) };
    }
    const hit = index.get(raw);
    if (hit) return { channel: byId.get(hit), model: raw };
    // 赤裸模型名查不到时回落第一家，但留日志便于排查。
    if (typeof log === "function") log(`模型 "${raw}" 未在渠道清单中，回落到默认渠道 ${channels[0].id}`);
    return { channel: channels[0], model: raw };
  };
}

function readBody(req, max = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("请求体超过上限"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const buf = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length,
    "cache-control": "no-store",
  });
  res.end(buf);
}

export function apply(ctx, config = {}) {
  const port = Number(config.port ?? 8788);
  const host = config.host ?? "127.0.0.1";
  const autoReload = config.autoReloadChannels !== false;
  /** 渠道配置文件位置；可在 patch 里改（测试/多实例时有用）。 */
  const channelsFile = config.channelsFile ? path.resolve(config.channelsFile) : CHANNELS_FILE;
  const statusFile = config.statusFile ? path.resolve(config.statusFile) : STATUS_FILE;

  const log = (m) => {
    try {
      ctx.logger.info(`[imagegen-relay] ${m}`);
    } catch {
      process.stderr.write(`[imagegen-relay] ${m}\n`);
    }
  };

  const writeStatus = (extra) => {
    try {
      fs.writeFileSync(
        statusFile,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            pid: process.pid,
            port,
            host,
            channels: state.channels.map((c) => ({ id: c.id, models: c.models.length })),
            source: state.source,
            ...(state.error ? { configError: state.error } : {}),
            ...(state.lastReloadError ? { lastReloadError: state.lastReloadError } : {}),
            ...extra,
          },
          null,
          2
        ),
        "utf8"
      );
    } catch {
      /* 状态文件写不了不影响主功能 */
    }
  };

  // ── 渠道状态（可热重载）───────────────────────────────────────────────
  // 优先级：config.channels（内联，测试/多实例隔离用） > 配置文件 > 内置默认。
  const inlineChannels = Array.isArray(config.channels) ? config.channels : undefined;
  const initial = inlineChannels
    ? (() => {
        try {
          return { channels: normalizeChannels(inlineChannels), source: "patch 内联 config.channels" };
        } catch (error) {
          return {
            channels: normalizeChannels(DEFAULT_CHANNELS),
            source: "内置默认（内联渠道配置非法）",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })()
    : loadChannels(channelsFile);
  const state = {
    channels: initial.channels,
    source: initial.source,
    error: initial.error,
    /** 最近一次重载被拒绝的原因（配置写错时给用户看）。 */
    lastReloadError: undefined,
    route: buildRouter(initial.channels),
    mtimeMs: fs.existsSync(channelsFile) ? fs.statSync(channelsFile).mtimeMs : 0,
  };
  if (initial.error) log(`渠道配置有问题，暂用内置默认: ${initial.error}`);

  /** 重新读盘并在成功时原子替换路由。 */
  const reloadChannels = (reason) => {
    if (inlineChannels) {
      return { ok: true, channels: state.channels.map((c) => ({ id: c.id, models: c.models })), note: "渠道由 patch 内联指定，忽略文件重载" };
    }
    const next = loadChannels(channelsFile);
    if (next.error && !initial.error) {
      // 写错了：保留原渠道，但把原因记下来，让 /health 能报出来。
      state.lastReloadError = next.error;
      log(`重载失败(${reason})，保持原渠道: ${next.error}`);
      writeStatus({ phase: "reload-rejected", reason, error: next.error });
      return { ok: false, error: next.error, keptChannels: state.channels.map((c) => c.id) };
    }
    const before = state.channels.map((c) => c.id).join(",");
    state.channels = next.channels;
    state.source = next.source;
    state.error = next.error;
    state.lastReloadError = undefined;
    state.route = buildRouter(next.channels);
    state.mtimeMs = fs.existsSync(channelsFile) ? fs.statSync(channelsFile).mtimeMs : 0;
    const after = next.channels.map((c) => c.id).join(",");
    if (before !== after) log(`渠道已重载(${reason}): ${before} → ${after}（共 ${next.channels.length} 家）`);
    writeStatus({ phase: "reloaded", reason });
    return { ok: true, channels: next.channels.map((c) => ({ id: c.id, models: c.models })) };
  };

  /**
   * 自动重载：每次请求前按 mtime 判断一次。
   * 只做一次 stat，开销可忽略；避免起定时器占用资源。
   */
  const maybeAutoReload = () => {
    if (!autoReload || inlineChannels) return;
    try {
      const m = fs.statSync(channelsFile).mtimeMs;
      if (m !== state.mtimeMs) reloadChannels("文件已修改");
    } catch {
      /* 文件不存在/读不到：保持不变 */
    }
  };

  writeStatus({ phase: "apply-called" });

  /**
   * 从 ~/.dsh/.credentials.yaml 直读 refs.<name>。
   * 兜底路径：ctx.credentials.resolve() 在某些 DSH 版本上要求「品牌化」的
   * CredentialRef 参数；这里直接读文件，保证中转不依赖宿主 API 的细节。
   */
  const readCredentialFile = (refName) => {
    const candidates = [
      path.join(DSH_HOME, ".credentials.yaml"),
      process.env.DSH_HOME ? path.join(process.env.DSH_HOME, ".credentials.yaml") : undefined,
    ].filter(Boolean);
    for (const file of candidates) {
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      let inRefs = false;
      for (const rawLine of text.split(/\r?\n/)) {
        if (/^refs:\s*$/.test(rawLine)) {
          inRefs = true;
          continue;
        }
        if (!inRefs) continue;
        if (/^\S/.test(rawLine)) break; // 离开 refs 段
        const m = rawLine.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
        if (!m || m[1] !== refName) continue;
        let v = m[2].trim();
        if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
        if (v.length > 0) return v;
      }
    }
    return undefined;
  };

  /**
   * 取该渠道自己的上游密钥。
   * 刻意【忽略】调用方传来的 key：dsh-image-gen 只会带一个统一占位 key，
   * 若把它转发给上游，会拿错渠道的凭据。
   */
  const resolveKey = async (channel) => {
    try {
      const resolved = await ctx.credentials?.resolve?.(channel.credentialRef);
      const value = resolved?.value?.trim();
      if (value) return value;
    } catch (error) {
      log(`凭据服务解析 ${channel.credentialRef} 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    const fromFile = readCredentialFile(channel.credentialRef);
    if (fromFile) return fromFile;
    throw new Error(`渠道 ${channel.id} 缺少凭据（${channel.credentialRef}），请在 .credentials.yaml 的 refs 中配置`);
  };

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${host}:${port}`);
    } catch {
      return sendJson(res, 400, { error: { message: "非法请求路径" } });
    }

    maybeAutoReload();

    if (url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        running: true,
        port,
        configFile: channelsFile,
        source: state.source,
        ...(state.error ? { configError: state.error } : {}),
        ...(state.lastReloadError ? { lastReloadError: state.lastReloadError } : {}),
        channels: state.channels.map((c) => ({ id: c.id, label: c.label, models: c.models })),
      });
    }

    if (url.pathname === "/v1/reload") {
      return sendJson(res, 200, reloadChannels("手动请求"));
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      return sendJson(res, 200, {
        object: "list",
        data: state.channels.flatMap((c) =>
          c.models.map((m) => ({ id: `${c.id}/${m}`, object: "model", owned_by: c.id }))
        ),
      });
    }

    if (url.pathname === "/v1/images/generations" && req.method === "POST") {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)).toString("utf8"));
      } catch (error) {
        return sendJson(res, 400, {
          error: { message: `请求体不是合法 JSON: ${error instanceof Error ? error.message : String(error)}` },
        });
      }
      const routed = state.route(payload?.model, log);
      if (routed.error) return sendJson(res, 400, { error: { message: routed.error } });
      const { channel, model } = routed;
      if (!channel) return sendJson(res, 400, { error: { message: `未匹配到渠道: ${payload?.model}` } });

      let key;
      try {
        key = await resolveKey(channel);
      } catch (error) {
        return sendJson(res, 400, { error: { message: String(error.message ?? error) } });
      }

      const started = Date.now();
      try {
        const upstream = await fetch(`${channel.base}/images/generations`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ ...payload, model }),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        const text = await upstream.text();
        log(`${channel.id}/${model} -> HTTP ${upstream.status} (${Date.now() - started}ms)`);
        const ct = upstream.headers.get("content-type") || "";
        // 上游出错时可能回 HTML（网关 502/504 页）。包成 JSON，避免调用方
        // 拿到 "<!DOCTYPE html>" 而报 JSON 解析错误、掩盖真实状态码。
        if (!upstream.ok && !ct.includes("json")) {
          return sendJson(res, upstream.status, {
            error: {
              message: `上游(${channel.id})返回 HTTP ${upstream.status}（非 JSON 响应）`,
              detail: text.slice(0, 300),
            },
          });
        }
        const buf = Buffer.from(text, "utf8");
        res.writeHead(upstream.status, {
          "content-type": ct || "application/json",
          "content-length": buf.length,
        });
        return res.end(buf);
      } catch (error) {
        log(`${channel.id}/${model} 失败: ${error instanceof Error ? error.message : String(error)}`);
        return sendJson(res, 502, {
          error: { message: `上游请求失败(${channel.id}): ${error instanceof Error ? error.message : String(error)}` },
        });
      }
    }

    // 非生成类端点（如 /images/edits）：model 前缀优先，否则转发到默认渠道
    if (url.pathname.startsWith("/v1/")) {
      let channel = state.channels[0];
      let suffix = "";
      const qModel = url.searchParams.get("model");
      if (qModel && qModel.includes("/")) {
        const routed = state.route(qModel, log);
        if (routed.channel) {
          channel = routed.channel;
          suffix = `?model=${encodeURIComponent(routed.model)}`;
        }
      }
      let key;
      try {
        key = await resolveKey(channel);
      } catch (error) {
        return sendJson(res, 400, { error: { message: String(error.message ?? error) } });
      }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
      }
      headers.authorization = `Bearer ${key}`;
      try {
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
        const upstream = await fetch(`${channel.base}${url.pathname.replace(/^\/v1/, "")}${suffix || url.search}`, {
          method: req.method,
          headers,
          body,
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") || "application/octet-stream",
          "content-length": buf.length,
        });
        return res.end(buf);
      } catch (error) {
        return sendJson(res, 502, {
          error: { message: `转发失败: ${error instanceof Error ? error.message : String(error)}` },
        });
      }
    }

    sendJson(res, 404, { error: { message: "not found" } });
  });

  // 随插件生命周期启停：DSH 启动即监听，卸载/重载插件即自动关闭。
  ctx.effect(() => {
    server.on("error", (error) => {
      const msg = error instanceof Error ? error.message : String(error);
      log(`监听失败: ${msg}`);
      writeStatus({ phase: "listen-error", error: msg });
    });
    server.listen(port, host, () => {
      log(`聚合中转已就绪: http://${host}:${port}/v1`);
      log(`渠道来源: ${state.source}`);
      log(`已接入 ${state.channels.length} 家渠道: ${state.channels.map((c) => `${c.id}(${c.models.length})`).join(", ")}`);
      if (autoReload) log(`加渠道请编辑: ${channelsFile}（保存后自动生效，无需重启）`);
      writeStatus({ phase: "listening", url: `http://${host}:${port}/v1` });
    });
    return () => {
      try {
        server.close();
        writeStatus({ phase: "closed" });
      } catch {
        /* 已关闭 */
      }
    };
  }, "dsh-imagegen-relay: aggregate endpoint");
}
