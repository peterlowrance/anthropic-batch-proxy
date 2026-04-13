import test from "node:test";
import assert from "node:assert/strict";
import { messageToSseFrames, rewriteCacheControl } from "../src/proxy.js";

function parseFrames(frames) {
  return frames.map((f) => {
    const m = f.match(/^event: (.+)\ndata: (.+)\n\n$/s);
    if (!m) throw new Error(`bad frame: ${JSON.stringify(f)}`);
    return { event: m[1], data: JSON.parse(m[2]) };
  });
}

test("message with text block synthesizes expected SSE sequence", () => {
  const msg = {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "Hello!" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2 },
  };
  const events = parseFrames(messageToSseFrames(msg));

  assert.deepEqual(events.map((e) => e.event), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);

  assert.equal(events[0].data.message.id, "msg_01");
  assert.equal(events[0].data.message.usage.output_tokens, 1); // convention
  assert.equal(events[0].data.message.content.length, 0);
  assert.equal(events[0].data.message.stop_reason, null);

  assert.deepEqual(events[1].data.content_block, { type: "text", text: "" });
  assert.equal(events[2].data.delta.type, "text_delta");
  assert.equal(events[2].data.delta.text, "Hello!");
  assert.equal(events[4].data.delta.stop_reason, "end_turn");
  assert.equal(events[4].data.usage.output_tokens, 2);
});

test("tool_use block emits input_json_delta with serialized input", () => {
  const msg = {
    id: "msg_02",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{
      type: "tool_use",
      id: "toolu_01",
      name: "get_weather",
      input: { location: "San Francisco", unit: "fahrenheit" },
    }],
    stop_reason: "tool_use",
    usage: { input_tokens: 20, output_tokens: 30 },
  };
  const events = parseFrames(messageToSseFrames(msg));

  const start = events.find((e) => e.event === "content_block_start");
  assert.equal(start.data.content_block.type, "tool_use");
  assert.equal(start.data.content_block.id, "toolu_01");
  assert.deepEqual(start.data.content_block.input, {});

  const delta = events.find((e) => e.event === "content_block_delta");
  assert.equal(delta.data.delta.type, "input_json_delta");
  const parsed = JSON.parse(delta.data.delta.partial_json);
  assert.deepEqual(parsed, { location: "San Francisco", unit: "fahrenheit" });
});

test("thinking block emits thinking_delta and signature_delta", () => {
  const msg = {
    id: "msg_03",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      { type: "thinking", thinking: "Let me reason...", signature: "sig_abc" },
      { type: "text", text: "Answer." },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 10 },
  };
  const events = parseFrames(messageToSseFrames(msg));

  // Order matters: thinking block (index 0) before text block (index 1)
  const indexed = events.filter((e) => e.data.index !== undefined);
  assert.equal(indexed[0].data.index, 0); // thinking start
  assert.equal(indexed[0].data.content_block.type, "thinking");

  const thinkingDelta = events.find((e) =>
    e.event === "content_block_delta" && e.data.delta?.type === "thinking_delta"
  );
  assert.equal(thinkingDelta.data.delta.thinking, "Let me reason...");

  const sigDelta = events.find((e) =>
    e.event === "content_block_delta" && e.data.delta?.type === "signature_delta"
  );
  assert.equal(sigDelta.data.delta.signature, "sig_abc");

  // The text block at index 1 should follow
  const textStart = events.find((e) =>
    e.event === "content_block_start" && e.data.index === 1
  );
  assert.equal(textStart.data.content_block.type, "text");
});

test("rewriteCacheControl 1h sets ttl on every cache_control", () => {
  const body = {
    system: [
      { type: "text", text: "long instructions", cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: [
        { type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "5m" } },
      ]},
    ],
    tools: [
      { name: "x", cache_control: { type: "ephemeral" } },
    ],
  };
  rewriteCacheControl(body, "1h");
  assert.equal(body.system[0].cache_control.ttl, "1h");
  assert.equal(body.messages[0].content[0].cache_control.ttl, "1h"); // overrides 5m
  assert.equal(body.tools[0].cache_control.ttl, "1h");
});

test("rewriteCacheControl 5m strips ttl (back to API default)", () => {
  const body = {
    system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }],
  };
  rewriteCacheControl(body, "5m");
  assert.equal(body.system[0].cache_control.ttl, undefined);
  assert.equal(body.system[0].cache_control.type, "ephemeral"); // type preserved
});

test("rewriteCacheControl passthrough leaves body untouched", () => {
  const body = {
    system: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: "hi" }],
  };
  const before = JSON.stringify(body);
  rewriteCacheControl(body, "passthrough");
  assert.equal(JSON.stringify(body), before);
});

test("rewriteCacheControl handles bodies with no cache_control", () => {
  const body = { messages: [{ role: "user", content: "hello" }], max_tokens: 100 };
  const before = JSON.stringify(body);
  rewriteCacheControl(body, "1h");
  assert.equal(JSON.stringify(body), before);
});

test("empty content produces just start + delta + stop", () => {
  const msg = {
    id: "msg_04",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 0 },
  };
  const events = parseFrames(messageToSseFrames(msg));
  assert.deepEqual(events.map((e) => e.event), [
    "message_start", "message_delta", "message_stop",
  ]);
});
