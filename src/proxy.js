// Core proxy: http server + batch submit/poll + SSE synthesis.
// No runtime deps. Uses only native node (http, fetch, timers).

import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_UPSTREAM = "https://api.anthropic.com";

const log = (msg) => process.stderr.write(`[anthropic-batch-proxy] ${msg}\n`);

// --- SSE helpers --------------------------------------------------------

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Convert a completed Message object into the SSE event sequence that a
 * streaming caller (Claude Code, SDKs) would expect to see.
 */
export function messageToSseFrames(msg) {
  const frames = [];

  const startMsg = {
    id: msg.id,
    type: "message",
    role: msg.role ?? "assistant",
    model: msg.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { ...(msg.usage ?? {}), output_tokens: 1 },
  };
  frames.push(sseFrame("message_start", { type: "message_start", message: startMsg }));

  const content = msg.content ?? [];
  for (let idx = 0; idx < content.length; idx++) {
    const block = content[idx];
    const t = block.type;

    if (t === "text") {
      frames.push(sseFrame("content_block_start", {
        type: "content_block_start", index: idx,
        content_block: { type: "text", text: "" },
      }));
      if (block.text) {
        frames.push(sseFrame("content_block_delta", {
          type: "content_block_delta", index: idx,
          delta: { type: "text_delta", text: block.text },
        }));
      }
      frames.push(sseFrame("content_block_stop", { type: "content_block_stop", index: idx }));
    } else if (t === "tool_use") {
      frames.push(sseFrame("content_block_start", {
        type: "content_block_start", index: idx,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      }));
      frames.push(sseFrame("content_block_delta", {
        type: "content_block_delta", index: idx,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
      }));
      frames.push(sseFrame("content_block_stop", { type: "content_block_stop", index: idx }));
    } else if (t === "thinking") {
      frames.push(sseFrame("content_block_start", {
        type: "content_block_start", index: idx,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }));
      if (block.thinking) {
        frames.push(sseFrame("content_block_delta", {
          type: "content_block_delta", index: idx,
          delta: { type: "thinking_delta", thinking: block.thinking },
        }));
      }
      if (block.signature) {
        frames.push(sseFrame("content_block_delta", {
          type: "content_block_delta", index: idx,
          delta: { type: "signature_delta", signature: block.signature },
        }));
      }
      frames.push(sseFrame("content_block_stop", { type: "content_block_stop", index: idx }));
    } else {
      // Unknown block type: surface it as-is so the client has something structural.
      frames.push(sseFrame("content_block_start", {
        type: "content_block_start", index: idx, content_block: block,
      }));
      frames.push(sseFrame("content_block_stop", { type: "content_block_stop", index: idx }));
    }
  }

  frames.push(sseFrame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: msg.stop_reason ?? null, stop_sequence: msg.stop_sequence ?? null },
    usage: { output_tokens: msg.usage?.output_tokens ?? 0 },
  }));
  frames.push(sseFrame("message_stop", { type: "message_stop" }));
  return frames;
}

// --- HTTP helpers -------------------------------------------------------

function forwardHeaders(req) {
  const out = {
    "anthropic-version": req.headers["anthropic-version"] ?? "2023-06-01",
    "content-type": "application/json",
  };
  if (req.headers["x-api-key"]) out["x-api-key"] = req.headers["x-api-key"];
  if (req.headers["authorization"]) out["authorization"] = req.headers["authorization"];
  if (req.headers["anthropic-beta"]) out["anthropic-beta"] = req.headers["anthropic-beta"];
  return out;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// --- Cache TTL rewrite --------------------------------------------------

const VALID_CACHE_TTLS = new Set(["1h", "5m", "passthrough"]);

/**
 * Walk a request body and normalize every cache_control's ttl.
 *  - "1h":          set ttl="1h" on every cache_control
 *  - "5m":          delete ttl (5m is the API default)
 *  - "passthrough": leave caller's cache_control untouched
 * Mutates in place.
 */
export function rewriteCacheControl(obj, ttl) {
  if (ttl === "passthrough" || obj == null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) rewriteCacheControl(item, ttl);
    return;
  }
  if (obj.cache_control && typeof obj.cache_control === "object") {
    if (ttl === "5m") delete obj.cache_control.ttl;
    else obj.cache_control.ttl = ttl;
  }
  for (const key of Object.keys(obj)) rewriteCacheControl(obj[key], ttl);
}

// --- Batch lifecycle ----------------------------------------------------

async function submitBatch(upstream, headers, params) {
  const customId = `req-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const r = await fetch(`${upstream}/v1/messages/batches`, {
    method: "POST",
    headers,
    body: JSON.stringify({ requests: [{ custom_id: customId, params }] }),
  });
  if (!r.ok) {
    const errText = await r.text();
    const err = new Error(`batch submit ${r.status}: ${errText}`);
    err.status = r.status;
    err.body = errText;
    throw err;
  }
  const data = await r.json();
  return { batchId: data.id, customId };
}

async function getBatch(upstream, headers, batchId) {
  const r = await fetch(`${upstream}/v1/messages/batches/${batchId}`, { headers });
  if (!r.ok) throw new Error(`batch get ${r.status}: ${await r.text()}`);
  return r.json();
}

async function fetchResultLine(headers, resultsUrl, customId) {
  const r = await fetch(resultsUrl, { headers });
  if (!r.ok) throw new Error(`results ${r.status}: ${await r.text()}`);
  const text = await r.text();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.custom_id === customId) return obj;
  }
  throw new Error(`custom_id ${customId} not found in results`);
}

// --- Request handlers ---------------------------------------------------

function errorPayload(type, message) {
  return { type: "error", error: { type, message } };
}

async function handleMessages(req, res, cfg) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify(errorPayload("invalid_request_error", `bad json: ${e.message}`)));
    return;
  }

  const streamRequested = body.stream === true;
  delete body.stream;

  rewriteCacheControl(body, cfg.cacheTtl);

  const headers = forwardHeaders(req);
  const sessionId = req.headers["x-claude-code-session-id"] ?? "unknown";

  if (streamRequested) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    res.flushHeaders?.();
    res.write(sseFrame("ping", { type: "ping" }));

    let batchId, customId;
    try {
      ({ batchId, customId } = await submitBatch(cfg.upstream, headers, body));
    } catch (e) {
      log(`session=${sessionId} submit failed: ${e.message.slice(0, 200)}`);
      let err;
      try { err = JSON.parse(e.body); }
      catch { err = errorPayload("api_error", e.message); }
      res.write(sseFrame("error", err));
      res.end();
      return;
    }
    log(`session=${sessionId} batch=${batchId} submitted`);

    // Client disconnect -> abandon polling (batch keeps running upstream; no cleanup for v0)
    let aborted = false;
    req.on("close", () => { aborted = true; });

    let delay = cfg.pollStart;
    let batch;
    while (true) {
      if (aborted) {
        log(`session=${sessionId} batch=${batchId} client disconnected`);
        return;
      }
      try {
        batch = await getBatch(cfg.upstream, headers, batchId);
      } catch (e) {
        log(`session=${sessionId} batch=${batchId} poll failed: ${e.message}`);
        res.write(sseFrame("error", errorPayload("api_error", e.message)));
        res.end();
        return;
      }
      if (batch.processing_status === "ended") break;
      log(`session=${sessionId} batch=${batchId} status=${batch.processing_status} next_poll=${delay.toFixed(1)}s`);
      res.write(sseFrame("ping", { type: "ping" }));
      await sleep(delay * 1000);
      delay = Math.min(delay * cfg.pollMult, cfg.pollMax);
    }

    let resultLine;
    try {
      resultLine = await fetchResultLine(headers, batch.results_url, customId);
    } catch (e) {
      log(`session=${sessionId} batch=${batchId} result fetch failed: ${e.message}`);
      res.write(sseFrame("error", errorPayload("api_error", e.message)));
      res.end();
      return;
    }
    const rType = resultLine.result.type;
    log(`session=${sessionId} batch=${batchId} result=${rType}`);

    if (rType === "succeeded") {
      for (const frame of messageToSseFrames(resultLine.result.message)) {
        res.write(frame);
      }
    } else {
      const err = resultLine.result.error ?? errorPayload("api_error", `batch result: ${rType}`);
      res.write(sseFrame("error", err));
    }
    res.end();
    return;
  }

  // Non-streaming: wait, return the Message JSON verbatim.
  let batchId, customId;
  try {
    ({ batchId, customId } = await submitBatch(cfg.upstream, headers, body));
  } catch (e) {
    log(`session=${sessionId} submit failed: ${e.message.slice(0, 200)}`);
    res.writeHead(e.status ?? 502, { "content-type": "application/json" });
    res.end(e.body ?? JSON.stringify(errorPayload("api_error", e.message)));
    return;
  }
  log(`session=${sessionId} batch=${batchId} submitted (sync)`);

  let delay = cfg.pollStart;
  let batch;
  while (true) {
    batch = await getBatch(cfg.upstream, headers, batchId);
    if (batch.processing_status === "ended") break;
    log(`session=${sessionId} batch=${batchId} status=${batch.processing_status} next_poll=${delay.toFixed(1)}s`);
    await sleep(delay * 1000);
    delay = Math.min(delay * cfg.pollMult, cfg.pollMax);
  }

  const resultLine = await fetchResultLine(headers, batch.results_url, customId);
  const rType = resultLine.result.type;
  log(`session=${sessionId} batch=${batchId} result=${rType}`);

  if (rType === "succeeded") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(resultLine.result.message));
  } else {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify(resultLine.result.error ?? errorPayload("api_error", `batch result: ${rType}`)));
  }
}

async function handleCountTokens(req, res, cfg) {
  const body = await readRaw(req);
  const r = await fetch(`${cfg.upstream}/v1/messages/count_tokens`, {
    method: "POST",
    headers: forwardHeaders(req),
    body,
  });
  res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
  res.end(Buffer.from(await r.arrayBuffer()));
}

// --- Server setup -------------------------------------------------------

export function startProxy({
  port = 0,
  host = "127.0.0.1",
  upstream = DEFAULT_UPSTREAM,
  pollStart = 5,
  pollMax = 60,
  pollMult = 2,
  cacheTtl = "1h",
} = {}) {
  if (!VALID_CACHE_TTLS.has(cacheTtl)) {
    throw new Error(`cacheTtl must be one of ${[...VALID_CACHE_TTLS].join(", ")}, got: ${cacheTtl}`);
  }
  const cfg = { upstream, pollStart, pollMax, pollMult, cacheTtl };

  const server = http.createServer((req, res) => {
    const url = req.url?.split("?")[0];

    if (req.method === "GET" && url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url === "/v1/messages") {
      handleMessages(req, res, cfg).catch((e) => {
        log(`unhandled: ${e.stack ?? e.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify(errorPayload("api_error", e.message)));
        } else {
          try { res.end(); } catch {}
        }
      });
      return;
    }
    if (req.method === "POST" && url === "/v1/messages/count_tokens") {
      handleCountTokens(req, res, cfg).catch((e) => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify(errorPayload("api_error", e.message)));
        }
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify(errorPayload("not_found", `no route for ${req.method} ${url}`)));
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      const baseUrl = `http://${host}:${actualPort}`;
      log(`listening on ${baseUrl} -> ${upstream}`);
      resolve({
        server,
        port: actualPort,
        host,
        baseUrl,
        stop: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
