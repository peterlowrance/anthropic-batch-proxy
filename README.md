# anthropic-batch-proxy

A drop-in proxy for the Anthropic Messages API that transparently routes each
call through the [Message Batches API][batches]. **50% cheaper inference**
in exchange for **minutes-per-turn latency**.

Built for agents doing long, unattended work: overnight code reviews,
batch test runs, and exploration jobs where cost matters more than
wall-clock time.

> Not affiliated with or endorsed by Anthropic. Use of this proxy is
> subject to [Anthropic's Usage Policies][policies]. You pay for all tokens
> with your own API key.

## How it works

```
  your agent  ──►  proxy  ──►  POST /v1/messages/batches      ──►  Anthropic
                       ▲                    │
                       │                    ▼
                       │     poll w/ exponential backoff (5s→60s)
                       │                    │
                       │     GET /v1/messages/batches/{id}
                       ◄────  synthesized SSE stream  ◄───── batch result
```

Each Messages request becomes a 1-request batch. The proxy holds the
connection open (sending SSE `ping` keepalives) until the batch ends,
then synthesizes the normal streaming event sequence and returns the
result. Callers see a slow-but-standard Messages response.

## Trade-offs (read before adopting)

- **Latency floor is ~3-4 min per turn.** Multi-turn agents with N tool-use
  rounds take ~N x 4 min. A real test run took 11 turns / 24 min.
- **Not for interactive use.** Anything a human watches.
- **Claude Code works.** Long SSE holds + ping keepalives survive the
  client's read timeout. Multi-turn tool-use loops work end-to-end.
- **Prompt caching survives tight turns** (hit rate was >90% in testing)
  but is fragile. If a batch takes >5min, you fall off the ephemeral
  cache and cost jumps.
- **No SLA. No retries. No resumption on disconnect.** If your client
  closes mid-batch, the batch keeps running upstream (wasted spend) and
  the request fails.
- **`count_tokens` is pass-through.** No batch equivalent; handled sync.

## Install

```bash
npm install -g anthropic-batch-proxy
```

Requires Node ≥ 20. Zero runtime dependencies.

## Usage

### 1. CLI wrapper (drop-in for `claude`)

```bash
anthropic-batch --print "review this PR"
anthropic-batch claude mcp list
```

Starts an ephemeral proxy on a free local port, sets `ANTHROPIC_BASE_URL`
for the child, execs `claude ...`, tears down on exit.

### 2. Standalone daemon (sidecar / Docker)

```bash
PORT=8787 anthropic-batch-proxy
```

Then point any Anthropic-format client at it:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
claude   # or your own SDK caller
```

**Docker Compose sidecar:**

```yaml
services:
  your-app:
    environment:
      ANTHROPIC_BASE_URL: http://batch-proxy:8787
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}

  batch-proxy:
    image: node:20-alpine
    command: npx -y anthropic-batch-proxy
    environment:
      PORT: 8787
      BATCH_PROXY_HOST: 0.0.0.0
```

### 3. Library

```js
import { startProxy } from "anthropic-batch-proxy";

const { baseUrl, stop } = await startProxy({ port: 0 });
// ... point your SDK at baseUrl ...
await stop();
```

## Configuration

| env var | default | |
|---|---|---|
| `PORT` | `8787` | Daemon listen port |
| `BATCH_PROXY_HOST` | `0.0.0.0` | Daemon bind address |
| `BATCH_PROXY_UPSTREAM` | `https://api.anthropic.com` | API base URL |
| `BATCH_PROXY_POLL_START` | `5` | Initial poll interval (seconds) |
| `BATCH_PROXY_POLL_MAX` | `60` | Max poll interval (seconds) |
| `BATCH_PROXY_POLL_MULT` | `2` | Exponential backoff multiplier |

Auth: the proxy forwards whatever `x-api-key` / `Authorization` header the
client sends. No key is stored in the proxy.

## Security

**Do not expose this proxy on a public network.** It forwards any client
auth header upstream with no validation. Run on localhost or behind a
trusted network boundary only.

## License

MIT. See [LICENSE](LICENSE).

[batches]: https://docs.claude.com/en/docs/build-with-claude/batch-processing
[policies]: https://www.anthropic.com/legal/aup
