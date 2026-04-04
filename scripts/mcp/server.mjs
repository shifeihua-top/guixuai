#!/usr/bin/env node
/**
 * GuiXuAI MCP server (stdio, JSON-RPC framing).
 * Exposes existing GuiXuAI HTTP APIs as MCP tools for OpenClaw or any MCP client.
 */

import fs from "fs/promises";
import path from "path";

const SERVER_NAME = "guixuai-mcp";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

const BASE_URL = (process.env.GUIXUAI_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const API_TOKEN = process.env.GUIXUAI_API_TOKEN || "";

const TOOL_NAME_LIST_MODELS = "guixuai_list_models";
const TOOL_NAME_CHAT_COMPLETION = "guixuai_chat_completion";
const TOOL_NAME_IMAGE_EDIT = "guixuai_image_edit";
const TOOL_NAME_GET_COOKIES = "guixuai_get_cookies";

const tools = [
  {
    name: TOOL_NAME_LIST_MODELS,
    description: "List currently available models from /v1/models.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAME_CHAT_COMPLETION,
    description: "Call /v1/chat/completions for text or multimodal generation.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model id from /v1/models." },
        prompt: { type: "string", description: "Shortcut for one user message." },
        messages: {
          type: "array",
          description: "OpenAI-style messages. Used when prompt is not provided.",
        },
        stream: {
          type: "boolean",
          description: "Whether to use streaming. Default false for MCP usage.",
          default: false,
        },
      },
      required: ["model"],
      additionalProperties: true,
    },
  },
  {
    name: TOOL_NAME_IMAGE_EDIT,
    description:
      "Edit or transform a local image using /v1/chat/completions with image input. Optionally saves output image file.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: "Image model id, e.g. seedream-4.5 or ai-cutout.",
          default: "seedream-4.5",
        },
        prompt: { type: "string", description: "Image edit instruction." },
        image_path: { type: "string", description: "Absolute or relative local image path." },
        output_path: { type: "string", description: "Optional output file path." },
      },
      required: ["prompt", "image_path"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAME_GET_COOKIES,
    description: "Query cookies from /v1/cookies for troubleshooting login/session.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Worker/instance name query param." },
        domain: { type: "string", description: "Cookie domain filter query param." },
      },
      additionalProperties: false,
    },
  },
];

function ensureAuth() {
  if (!API_TOKEN) {
    throw new Error(
      "GUIXUAI_API_TOKEN is required. Set GUIXUAI_API_TOKEN before starting."
    );
  }
}

async function apiFetch(pathname, options = {}) {
  ensureAuth();
  const url = `${BASE_URL}${pathname}`;
  const headers = {
    Authorization: `Bearer ${API_TOKEN}`,
    ...options.headers,
  };
  const resp = await fetch(url, { ...options, headers });
  const text = await resp.text();
  const contentType = resp.headers.get("content-type") || "";
  const asJson = contentType.includes("application/json");
  const body = asJson ? safeJsonParse(text) : text;
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toTextResult(text) {
  return { content: [{ type: "text", text }] };
}

function writeMessage(message) {
  const json = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
  process.stdout.write(header + json);
}

function writeResponse(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function getMimeTypeByExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

function parseDataImage(content) {
  const m = /^data:(image\/[^;]+);base64,(.+)$/s.exec(content || "");
  if (!m) return null;
  return { mime: m[1], base64: m[2] };
}

async function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

function extByMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "jpg";
}

async function callTool(name, args = {}) {
  if (name === TOOL_NAME_LIST_MODELS) {
    const data = await apiFetch("/v1/models");
    return toTextResult(JSON.stringify(data, null, 2));
  }

  if (name === TOOL_NAME_CHAT_COMPLETION) {
    const { model, prompt, messages, stream = false, ...rest } = args;
    if (!model) throw new Error("model is required");
    const finalMessages = prompt
      ? [{ role: "user", content: prompt }]
      : Array.isArray(messages)
        ? messages
        : null;
    if (!finalMessages) {
      throw new Error("Either prompt or messages is required.");
    }

    const payload = {
      model,
      stream: Boolean(stream),
      messages: finalMessages,
      ...rest,
    };
    const data = await apiFetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return toTextResult(JSON.stringify(data, null, 2));
  }

  if (name === TOOL_NAME_IMAGE_EDIT) {
    const { model = "seedream-4.5", prompt, image_path, output_path } = args;
    if (!prompt) throw new Error("prompt is required");
    if (!image_path) throw new Error("image_path is required");

    const imgPath = path.resolve(image_path);
    const imageBuffer = await fs.readFile(imgPath);
    const mime = getMimeTypeByExt(imgPath);
    const b64 = imageBuffer.toString("base64");

    const payload = {
      model,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
    };

    const data = await apiFetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const content = data?.choices?.[0]?.message?.content;
    const parsed = typeof content === "string" ? parseDataImage(content) : null;
    if (parsed) {
      const outPath =
        output_path
          ? path.resolve(output_path)
          : path.join(process.cwd(), "data", "test_outputs", `mcp_image_${Date.now()}.${extByMime(parsed.mime)}`);
      await ensureParentDir(outPath);
      await fs.writeFile(outPath, Buffer.from(parsed.base64, "base64"));
      return toTextResult(
        JSON.stringify(
          {
            ok: true,
            model,
            output_path: outPath,
            mime: parsed.mime,
            request_id: data?.id || null,
          },
          null,
          2
        )
      );
    }

    return toTextResult(JSON.stringify(data, null, 2));
  }

  if (name === TOOL_NAME_GET_COOKIES) {
    const params = new URLSearchParams();
    if (args.name) params.set("name", args.name);
    if (args.domain) params.set("domain", args.domain);
    const data = await apiFetch(`/v1/cookies${params.toString() ? `?${params}` : ""}`);
    return toTextResult(JSON.stringify(data, null, 2));
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    const protocolVersion = params?.protocolVersion || DEFAULT_PROTOCOL_VERSION;
    writeResponse(id, {
      protocolVersion,
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      capabilities: {
        tools: {},
      },
    });
    return;
  }

  if (method === "tools/list") {
    writeResponse(id, { tools });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    const result = await callTool(name, args);
    writeResponse(id, result);
    return;
  }

  if (method === "ping") {
    writeResponse(id, {});
    return;
  }

  writeError(id, -32601, `Method not found: ${method}`);
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  parseBuffer();
});

process.stdin.on("end", () => {
  process.exit(0);
});

function parseBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const headerText = buffer.slice(0, headerEnd).toString("utf8");
    const lenLine = headerText
      .split("\r\n")
      .find((line) => line.toLowerCase().startsWith("content-length:"));

    if (!lenLine) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const contentLength = Number(lenLine.split(":")[1]?.trim());
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const totalLen = headerEnd + 4 + contentLength;
    if (buffer.length < totalLen) return;

    const bodyBuf = buffer.slice(headerEnd + 4, totalLen);
    buffer = buffer.slice(totalLen);

    let msg;
    try {
      msg = JSON.parse(bodyBuf.toString("utf8"));
    } catch (err) {
      continue;
    }

    if (!msg || msg.jsonrpc !== "2.0") continue;

    if (msg.id === undefined) {
      // Notification, ignore.
      continue;
    }

    handleRequest(msg).catch((err) => {
      writeError(msg.id, -32000, err.message || String(err));
    });
  }
}
