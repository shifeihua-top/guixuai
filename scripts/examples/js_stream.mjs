#!/usr/bin/env node
/**
 * Minimal runnable streaming client for POST /v1/chat/completions.
 *
 * Example:
 *   node scripts/examples/js_stream.mjs \
 *     --token sk-xxx \
 *     --model seed-thinking \
 *     --prompt "输出5条营销文案"
 */

function argValue(name, fallback = "") {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

const baseUrl = argValue("--base-url", process.env.BASE_URL || "http://127.0.0.1:3000");
const token = argValue("--token", process.env.API_TOKEN || "");
const model = argValue("--model", "seed-thinking");
const prompt = argValue("--prompt", "");

if (!token) {
  console.error("ERROR: missing token. use --token or API_TOKEN env");
  process.exit(2);
}
if (!prompt) {
  console.error("ERROR: missing prompt. use --prompt");
  process.exit(2);
}

const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model,
    stream: true,
    messages: [{ role: "user", content: prompt }],
  }),
});

if (!resp.ok) {
  const text = await resp.text();
  console.error(`HTTP ${resp.status}: ${text}`);
  process.exit(1);
}

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta?.content || "";
      if (delta) process.stdout.write(delta);
    } catch (_) {
      // ignore heartbeat/comment/non-json chunk
    }
  }
}

process.stdout.write("\n");

