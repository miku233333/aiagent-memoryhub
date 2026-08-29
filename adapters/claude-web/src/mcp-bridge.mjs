#!/usr/bin/env node

import crypto from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

import { normalizeServiceUrl, readHubToken } from "./config-security.mjs";
import { HubRestClient } from "./rest-client.mjs";
import { containsRecognizedSecret } from "./secrets.mjs";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  MCP_PROTOCOL_VERSION,
  "2025-03-26",
  "2024-11-05",
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function parseInteger(value, fallback, { min, max }) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function bool(value) {
  return value === "1" || value === "true";
}

function requiredId(value, name, { optional = false } = {}) {
  const cleaned = value?.trim();
  if (!cleaned) {
    if (optional) return undefined;
    throw new Error(`${name} is required`);
  }
  if (cleaned.length > 200 || /[\u0000-\u001f\u007f]/u.test(cleaned)) {
    throw new Error(`${name} is invalid`);
  }
  return cleaned;
}

export function bridgeConfigFromEnv(env = process.env) {
  const host = env.CLAUDE_WEB_BRIDGE_HOST || "127.0.0.1";
  const bearerToken = env.CLAUDE_WEB_BRIDGE_BEARER_TOKEN?.trim() || undefined;
  const trustExternalAuth = bool(env.CLAUDE_WEB_BRIDGE_TRUST_EXTERNAL_AUTH);
  if (!LOOPBACK_HOSTS.has(host) && !trustExternalAuth) {
    throw new Error(
      "Refusing a non-loopback listener unless CLAUDE_WEB_BRIDGE_TRUST_EXTERNAL_AUTH=1 confirms a trusted TLS/OAuth gateway",
    );
  }

  return {
    host,
    port: parseInteger(env.CLAUDE_WEB_BRIDGE_PORT, 8790, { min: 1, max: 65_535 }),
    hubUrl: normalizeServiceUrl(env.MEMORY_HUB_URL, {
      name: "MEMORY_HUB_URL",
      fallback: "http://127.0.0.1:8787",
      stripTrailingSlash: true,
    }),
    hubToken: readHubToken(env),
    userId: requiredId(env.MEMORY_HUB_USER_ID, "MEMORY_HUB_USER_ID"),
    projectId: requiredId(env.MEMORY_HUB_PROJECT_ID, "MEMORY_HUB_PROJECT_ID", {
      optional: true,
    }),
    bearerToken,
    trustExternalAuth,
    allowedOrigins: new Set(
      (env.CLAUDE_WEB_BRIDGE_ALLOWED_ORIGINS || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
    enableWriteTools: bool(env.CLAUDE_WEB_ENABLE_WRITE_TOOLS),
    timeoutMs: parseInteger(env.MEMORY_HUB_TIMEOUT_MS, 2_000, {
      min: 100,
      max: 10_000,
    }),
    maxBodyBytes: parseInteger(env.CLAUDE_WEB_BRIDGE_MAX_BODY_BYTES, 1024 * 1024, {
      min: 4_096,
      max: 8 * 1024 * 1024,
    }),
  };
}

function scope(config) {
  return {
    user_id: config.userId,
    ...(config.projectId ? { project_id: config.projectId } : {}),
  };
}

function digest(parts) {
  return crypto
    .createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\0"))
    .digest("hex");
}

function authenticated(request, expectedToken) {
  if (!expectedToken) return true;
  const actual = crypto
    .createHash("sha256")
    .update(request.headers.authorization || "")
    .digest();
  const expected = crypto
    .createHash("sha256")
    .update(`Bearer ${expectedToken}`)
    .digest();
  return crypto.timingSafeEqual(actual, expected);
}

async function readJson(request, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("request_too_large");
      error.httpStatus = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    const error = new Error("parse_error");
    error.rpcCode = -32700;
    error.httpStatus = 400;
    throw error;
  }
}

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify(value)}\n`);
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

function ensureObject(value, name = "arguments") {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error(`${name}_must_be_an_object`);
    error.toolCode = "invalid_arguments";
    throw error;
  }
  return value;
}

function optionalString(value, name, maxLength) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    const error = new Error(`${name}_is_invalid`);
    error.toolCode = "invalid_arguments";
    throw error;
  }
  return value.trim() || undefined;
}

function requiredString(value, name, maxLength) {
  const cleaned = optionalString(value, name, maxLength);
  if (!cleaned) {
    const error = new Error(`${name}_is_required`);
    error.toolCode = "invalid_arguments";
    throw error;
  }
  return cleaned;
}

function safeExternalText(value, name, maxLength) {
  const text = requiredString(value, name, maxLength);
  if (containsRecognizedSecret(text)) {
    const error = new Error("secret_detected");
    error.toolCode = "secret_detected";
    throw error;
  }
  return text;
}

function projectedContextResponse(response) {
  return {
    schema_version: response.schema_version,
    target: "claude_web",
    rendered_content: response.rendered_content || "",
    items: Array.isArray(response.items)
      ? response.items.map((item) => ({
          id: item.id,
          rendered_content: item.rendered_content,
          changed: Boolean(item.changed),
          source_platform: item.source_platform,
          created_at: item.created_at,
        }))
      : [],
    setting: response.setting
      ? { cross_cultural_polish: Boolean(response.setting.cross_cultural_polish) }
      : undefined,
    delivery_state: response.delivery_state || "prepared",
  };
}

function toolResult(structuredContent, text) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function toolFailure(error) {
  const code = error?.toolCode || error?.code || "tool_failed";
  return {
    content: [{ type: "text", text: `Tool failed safely: ${code}` }],
    isError: true,
    structuredContent: { error: code },
  };
}

function readTools() {
  return [
    {
      name: "context_pack",
      title: "Load shared context",
      description:
        "Return approved cross-platform memory rendered for Claude Web in the connector's fixed user/project scope.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 1000 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "memory_search",
      title: "Search shared memory",
      description:
        "Search approved memory and return only Claude Web rendered projections, never canonical records.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 1000 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "projection_preview",
      title: "Preview internationalized phrasing",
      description:
        "Preview the target-specific projection for supplied text without storing or changing canonical memory.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", minLength: 1, maxLength: 100000 },
          protected_terms: {
            type: "array",
            maxItems: 200,
            items: { type: "string" },
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ];
}

function writeTools(config) {
  if (!config.enableWriteTools) return [];
  return [
    {
      name: "memory_propose",
      title: "Propose a memory for review",
      description:
        "Create a scoped pending memory proposal that requires separate review in the Hub.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", minLength: 1, maxLength: 20000 },
        },
        required: ["content"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ];
}

function listedTools(config) {
  return [...readTools(), ...writeTools(config)];
}

async function callTool(name, rawArguments, config, client) {
  try {
    const args = ensureObject(rawArguments);
    if (name === "context_pack" || name === "memory_search") {
      const query =
        name === "memory_search"
          ? safeExternalText(args.query, "query", 1_000)
          : optionalString(args.query, "query", 1_000);
      if (query && containsRecognizedSecret(query)) {
        const error = new Error("secret_detected");
        error.toolCode = "secret_detected";
        throw error;
      }
      const limit = args.limit === undefined ? 20 : args.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        const error = new Error("limit_is_invalid");
        error.toolCode = "invalid_arguments";
        throw error;
      }
      const result = await client.post("/v1/context-pack", {
        scope: scope(config),
        target: "claude_web",
        ...(query ? { query } : {}),
        limit,
        include_global: true,
        source_platform: "claude_web",
      });
      const projected = projectedContextResponse(result);
      return toolResult(
        projected,
        projected.rendered_content || "No approved memory matched this scope and query.",
      );
    }

    if (name === "projection_preview") {
      const content = safeExternalText(args.content, "content", 100_000);
      const protectedTerms = args.protected_terms ?? [];
      if (
        !Array.isArray(protectedTerms) ||
        protectedTerms.length > 200 ||
        protectedTerms.some(
          (term) => typeof term !== "string" || containsRecognizedSecret(term),
        )
      ) {
        const error = new Error("protected_terms_is_invalid");
        error.toolCode = "invalid_arguments";
        throw error;
      }
      const result = await client.post("/v1/projections/preview", {
        user_id: config.userId,
        target: "claude_web",
        content,
        protected_terms: protectedTerms,
      });
      return toolResult(result, result.rendered_content || content);
    }

    if (name === "memory_propose" && config.enableWriteTools) {
      const content = safeExternalText(args.content, "content", 20_000);
      const idempotencyKey = digest([
        "claude_web",
        config.userId,
        config.projectId,
        content,
      ]);
      const result = await client.post(
        "/v1/memory/proposals",
        {
          scope: scope(config),
          content,
          explicit_user_fact: false,
          source_platform: "claude_web",
          metadata: { origin: "claude_web_mcp" },
        },
        { idempotencyKey },
      );
      const receipt = {
        schema_version: result.schema_version,
        item_id: result.item?.id,
        status: result.item?.status,
        delivery_state: result.item ? "accepted" : "delivered_unverified",
      };
      return toolResult(
        receipt,
        result.item
          ? `Memory proposal accepted by the Hub with status ${result.item.status}.`
          : "Memory proposal delivered without a verifiable receipt.",
      );
    }

    const error = new Error("unknown_tool");
    error.toolCode = "unknown_tool";
    throw error;
  } catch (error) {
    return toolFailure(error);
  }
}

async function handleRpc(message, config, client) {
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return { status: 400, body: rpcError(message.id, -32600, "Invalid Request") };
  }
  if (!("id" in message)) return { status: 202 };

  if (message.method === "initialize") {
    const requested = message.params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
      ? requested
      : MCP_PROTOCOL_VERSION;
    return {
      status: 200,
      body: rpcResult(message.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ai-memory-sync-claude-web", version: "0.1.0" },
        instructions:
          "This connector uses a fixed user/project scope. Read tools return target-rendered context. Write tools, when enabled, create pending Hub proposals that require separate review.",
      }),
    };
  }
  if (message.method === "ping") return { status: 200, body: rpcResult(message.id, {}) };
  if (message.method === "tools/list") {
    return { status: 200, body: rpcResult(message.id, { tools: listedTools(config) }) };
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (typeof name !== "string") {
      return { status: 200, body: rpcError(message.id, -32602, "Invalid params") };
    }
    const result = await callTool(name, message.params?.arguments, config, client);
    return { status: 200, body: rpcResult(message.id, result) };
  }
  return { status: 200, body: rpcError(message.id, -32601, "Method not found") };
}

function originAllowed(request, config) {
  const origin = request.headers.origin;
  return !origin || config.allowedOrigins?.has(origin);
}

export function createMcpBridgeServer(config, { fetchImplementation = globalThis.fetch } = {}) {
  const client = new HubRestClient(config, fetchImplementation);
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://bridge.invalid");
    if (url.pathname === "/health" && request.method === "GET") {
      sendJson(response, 200, {
        status: "bridge_ready",
        target: "claude_web",
        scope_configured: true,
        write_tools_enabled: config.enableWriteTools,
        upstream_verified: false,
      });
      return;
    }
    if (url.pathname !== "/mcp") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!originAllowed(request, config)) {
      sendJson(response, 403, { error: "origin_not_allowed" });
      return;
    }
    if (!authenticated(request, config.bearerToken)) {
      response.setHeader("www-authenticate", "Bearer");
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET" || request.method === "DELETE") {
      response.setHeader("allow", "POST");
      response.statusCode = 405;
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      response.statusCode = 405;
      response.end();
      return;
    }

    let message;
    try {
      message = await readJson(request, config.maxBodyBytes);
      const result = await handleRpc(message, config, client);
      if (result.status === 202) {
        response.statusCode = 202;
        response.end();
        return;
      }
      sendJson(response, result.status, result.body);
    } catch (error) {
      sendJson(
        response,
        error?.httpStatus || 500,
        rpcError(message?.id, error?.rpcCode || -32603, "Request failed safely"),
      );
    }
  });
}

export async function startMcpBridge(config = bridgeConfigFromEnv()) {
  const server = createMcpBridgeServer(config);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  process.stderr.write(
    `[claude-web-bridge] listening on ${typeof address === "object" ? `${address.address}:${address.port}` : address}; target=claude_web; writes=${config.enableWriteTools ? "enabled" : "disabled"}\n`,
  );
  return server;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await startMcpBridge();
