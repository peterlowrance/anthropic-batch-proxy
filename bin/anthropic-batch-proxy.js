#!/usr/bin/env node
// Standalone proxy daemon. Reads config from env, listens forever.

import { startProxy } from "../src/proxy.js";

const port = Number(process.env.PORT ?? process.env.BATCH_PROXY_PORT ?? 8787);
const host = process.env.BATCH_PROXY_HOST ?? "0.0.0.0";
const upstream = process.env.BATCH_PROXY_UPSTREAM ?? "https://api.anthropic.com";
const pollStart = Number(process.env.BATCH_PROXY_POLL_START ?? 5);
const pollMax = Number(process.env.BATCH_PROXY_POLL_MAX ?? 60);
const pollMult = Number(process.env.BATCH_PROXY_POLL_MULT ?? 2);
const cacheTtl = process.env.BATCH_PROXY_CACHE_TTL ?? "1h";

const { server } = await startProxy({ port, host, upstream, pollStart, pollMax, pollMult, cacheTtl });

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    process.stderr.write(`[anthropic-batch-proxy] ${sig} received, shutting down\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
