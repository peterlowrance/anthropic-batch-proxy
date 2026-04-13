#!/usr/bin/env node
// Wrapper: start an ephemeral proxy on a free local port, spawn `claude ...`
// with ANTHROPIC_BASE_URL pointed at it, and exit when the child exits.
//
// Usage: anthropic-batch [claude args...]
//        anthropic-batch --print "summarize this file" < file.md
//
// Environment:
//   ANTHROPIC_BATCH_CMD      override the binary to spawn (default: "claude")
//   BATCH_PROXY_UPSTREAM     override upstream API base url

import { spawn } from "node:child_process";
import { startProxy } from "../src/proxy.js";

const upstream = process.env.BATCH_PROXY_UPSTREAM ?? "https://api.anthropic.com";
const claudeBin = process.env.ANTHROPIC_BATCH_CMD ?? process.env.CLAUDE_BATCH_CMD ?? "claude";
const childArgs = process.argv.slice(2);

const { server, baseUrl } = await startProxy({ port: 0, host: "127.0.0.1", upstream });

const child = spawn(claudeBin, childArgs, {
  stdio: "inherit",
  env: { ...process.env, ANTHROPIC_BASE_URL: baseUrl },
});

const shutdown = (code) => {
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 3000).unref();
};

child.on("exit", (code, signal) => {
  shutdown(signal ? 128 + (signal === "SIGTERM" ? 15 : 1) : (code ?? 0));
});
child.on("error", (err) => {
  process.stderr.write(`[anthropic-batch] failed to spawn ${claudeBin}: ${err.message}\n`);
  shutdown(127);
});

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    try { child.kill(sig); } catch {}
  });
}
