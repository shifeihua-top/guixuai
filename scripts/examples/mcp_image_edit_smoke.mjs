#!/usr/bin/env node
/**
 * Smoke test for MCP guixuai_image_edit output modes.
 *
 * It verifies output behavior for:
 * - inline: should not save files
 * - file: should save one file
 * - files: should save all returned data-image files
 *
 * Example:
 *   node scripts/examples/mcp_image_edit_smoke.mjs \
 *     --token sk-xxx \
 *     --model seedream-4.5 \
 *     --prompt "改成白底电商主图" \
 *     --image ./input.jpg
 */

import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

function argValue(name, fallback = "") {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function parseModes(raw) {
  const defaultModes = ["inline", "file", "files"];
  const source = (raw || defaultModes.join(",")).trim();
  const parts = source.split(",").map((s) => s.trim()).filter(Boolean);
  const uniq = [];
  for (const mode of parts) {
    if (!["inline", "file", "files"].includes(mode)) {
      throw new Error(`Unsupported mode: ${mode}`);
    }
    if (!uniq.includes(mode)) uniq.push(mode);
  }
  if (uniq.length === 0) return defaultModes;
  return uniq;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function statSize(filePath) {
  const st = await fs.stat(filePath);
  return st.size;
}

function requireTextResult(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("MCP result does not contain text payload");
  }
  return text;
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse MCP text payload as JSON: ${e.message}`);
  }
}

class McpStdioClient {
  constructor(child, timeoutMs) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);

    child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parseFrames();
    });

    child.on("exit", (code, signal) => {
      const reason = `MCP process exited (code=${code}, signal=${signal || "none"})`;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(reason));
      }
      this.pending.clear();
    });
  }

  parseFrames() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;

      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lenLine = header
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("content-length:"));

      if (!lenLine) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number(lenLine.split(":")[1]?.trim());
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const totalLength = headerEnd + 4 + contentLength;
      if (this.buffer.length < totalLength) return;

      const body = this.buffer.slice(headerEnd + 4, totalLength).toString("utf8");
      this.buffer = this.buffer.slice(totalLength);

      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }

      if (msg?.id === undefined) continue;

      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);

      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  writeMessage(message) {
    const json = JSON.stringify(message);
    const packet = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
    this.child.stdin.write(packet);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  async close() {
    try {
      this.child.stdin.end();
    } catch {
      // noop
    }
  }
}

async function ensureInputImage(imagePath) {
  if (imagePath) {
    const resolved = path.resolve(imagePath);
    if (!(await exists(resolved))) {
      throw new Error(`image not found: ${resolved}`);
    }
    return resolved;
  }

  const tmpDir = path.join(process.cwd(), "data", "test_inputs");
  await fs.mkdir(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, "mcp_smoke_input.png");

  // 1x1 transparent PNG
  const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgL0F7xkAAAAASUVORK5CYII=";
  await fs.writeFile(filePath, Buffer.from(tinyPngBase64, "base64"));
  return filePath;
}

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const defaultServer = path.resolve(__dirname, "../mcp/server.mjs");

  const baseUrl = argValue("--base-url", process.env.GUIXUAI_BASE_URL || "http://127.0.0.1:3000");
  const token = argValue("--token", process.env.GUIXUAI_API_TOKEN || "");
  const model = argValue("--model", "seedream-4.5");
  const prompt = argValue("--prompt", "生成一张蓝色圆点的极简图片");
  const ratio = argValue("--ratio", "1:1");
  const quality = argValue("--quality", "high");
  const timeoutMs = Number(argValue("--timeout-ms", "360000"));
  const modes = parseModes(argValue("--modes", "inline,file,files"));
  const imagePath = await ensureInputImage(argValue("--image", ""));
  const serverPath = path.resolve(argValue("--server", defaultServer));
  const outDir = path.resolve(argValue("--out-dir", path.join(process.cwd(), "data", "test_outputs", "mcp_smoke")));

  if (!token) {
    console.error("ERROR: missing token. use --token or GUIXUAI_API_TOKEN env");
    process.exit(2);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error("ERROR: --timeout-ms must be a positive number");
    process.exit(2);
  }

  await fs.mkdir(outDir, { recursive: true });

  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      GUIXUAI_BASE_URL: baseUrl,
      GUIXUAI_API_TOKEN: token,
    },
  });

  const client = new McpStdioClient(child, timeoutMs);
  const summary = [];

  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "mcp-image-edit-smoke", version: "0.1.0" },
      capabilities: {},
    });

    const listed = await client.request("tools/list", {});
    const names = (listed?.tools || []).map((t) => t.name);
    if (!names.includes("guixuai_image_edit")) {
      throw new Error("MCP tool guixuai_image_edit not found");
    }

    const stamp = Date.now();

    for (const mode of modes) {
      const targetPath = path.join(outDir, `smoke_${stamp}_${mode}.png`);
      const args = {
        model,
        prompt,
        image_path: imagePath,
        ratio,
        quality,
        output: mode,
        output_path: targetPath,
      };

      console.log(`\n[RUN] mode=${mode}`);
      const result = await client.request("tools/call", {
        name: "guixuai_image_edit",
        arguments: args,
      });

      const text = requireTextResult(result);
      const payload = parseJsonText(text);

      if (mode === "inline") {
        const wrote = await exists(targetPath);
        if (wrote) {
          throw new Error(`inline mode should not write file: ${targetPath}`);
        }
        summary.push({ mode, ok: true, note: "no file written" });
        console.log(`[PASS] inline: no file written`);
        continue;
      }

      if (payload?.ok !== true) {
        throw new Error(`${mode} mode did not return persisted-file payload (ok=true)`);
      }

      const outputPaths = Array.isArray(payload.output_paths) ? payload.output_paths : [];
      if (outputPaths.length === 0) {
        throw new Error(`${mode} mode returned empty output_paths`);
      }

      if (mode === "file" && Number(payload.saved_count) !== 1) {
        throw new Error(`file mode expected saved_count=1, got ${payload.saved_count}`);
      }

      if (mode === "files" && Number(payload.saved_count) < 1) {
        throw new Error(`files mode expected saved_count>=1, got ${payload.saved_count}`);
      }

      let totalBytes = 0;
      for (const p of outputPaths) {
        if (!(await exists(p))) {
          throw new Error(`saved file not found: ${p}`);
        }
        const size = await statSize(p);
        if (size <= 0) {
          throw new Error(`saved file is empty: ${p}`);
        }
        totalBytes += size;
      }

      summary.push({
        mode,
        ok: true,
        savedCount: payload.saved_count,
        imageCount: payload.image_count,
        totalBytes,
      });

      console.log(
        `[PASS] ${mode}: saved=${payload.saved_count}, images=${payload.image_count}, bytes=${totalBytes}`
      );
    }

    console.log("\n[SUMMARY]");
    for (const row of summary) {
      const parts = [
        `mode=${row.mode}`,
        "ok=true",
        row.savedCount !== undefined ? `saved=${row.savedCount}` : null,
        row.imageCount !== undefined ? `images=${row.imageCount}` : null,
        row.totalBytes !== undefined ? `bytes=${row.totalBytes}` : null,
        row.note || null,
      ].filter(Boolean);
      console.log(`- ${parts.join(", ")}`);
    }

    console.log("\nSmoke test passed.");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(`\n[FAIL] ${err.message}`);
  process.exit(1);
});
