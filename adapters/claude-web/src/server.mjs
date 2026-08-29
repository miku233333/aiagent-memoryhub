#!/usr/bin/env node

import crypto from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { normalizeServiceUrl, readHubToken } from "./config-security.mjs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function parseInteger(value, fallback, { min, max }) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function bool(value) {
  return value === "1" || value === "true";
}

export function configFromEnv(env = process.env) {
  const upstreamUrl = normalizeServiceUrl(env.HUB_MCP_URL, {
    name: "HUB_MCP_URL",
    fallback: "http://127.0.0.1:8787/mcp",
  });

  const host = env.CLAUDE_WEB_SHIM_HOST || "127.0.0.1";
  const bearerToken = env.CLAUDE_WEB_SHIM_BEARER_TOKEN?.trim() || undefined;
  const trustExternalAuth = bool(env.CLAUDE_WEB_SHIM_TRUST_EXTERNAL_AUTH);
  if (!LOOPBACK_HOSTS.has(host) && !trustExternalAuth) {
    throw new Error(
      "Refusing a non-loopback listener unless CLAUDE_WEB_SHIM_TRUST_EXTERNAL_AUTH=1 confirms a trusted TLS/OAuth gateway",
    );
  }

  return {
    upstreamUrl,
    host,
    port: parseInteger(env.CLAUDE_WEB_SHIM_PORT, 8790, { min: 1, max: 65_535 }),
    bearerToken,
    trustExternalAuth,
    upstreamToken: readHubToken(env),
    connectTimeoutMs: parseInteger(env.CLAUDE_WEB_SHIM_CONNECT_TIMEOUT_MS, 5_000, {
      min: 100,
      max: 30_000,
    }),
    maxBodyBytes: parseInteger(env.CLAUDE_WEB_SHIM_MAX_BODY_BYTES, 2 * 1024 * 1024, {
      min: 4_096,
      max: 16 * 1024 * 1024,
    }),
  };
}

function authorized(request, expectedToken) {
  if (!expectedToken) return true;
  const provided = request.headers.authorization || "";
  const expected = `Bearer ${expectedToken}`;
  const providedDigest = crypto.createHash("sha256").update(provided).digest();
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

async function readBody(request, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) {
      const error = new Error("request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function upstreamHeaders(request, config) {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(request.headers)) {
    const lowerName = name.toLowerCase();
    if (
      rawValue === undefined ||
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      lowerName === "host" ||
      lowerName === "content-length" ||
      lowerName === "cookie" ||
      (lowerName === "authorization" && config.bearerToken)
    ) {
      continue;
    }
    headers.set(name, Array.isArray(rawValue) ? rawValue.join(", ") : rawValue);
  }
  if (config.upstreamToken) headers.set("authorization", `Bearer ${config.upstreamToken}`);
  headers.set("x-memory-sync-target", "claude_web");
  return headers;
}

function copyResponseHeaders(upstreamResponse, response) {
  for (const [name, value] of upstreamResponse.headers) {
    const lowerName = name.toLowerCase();
    // Node fetch decodes compressed bodies. Forwarding the original encoding/length would
    // corrupt the downstream message; cookies are not part of MCP bearer/OAuth transport.
    if (
      !HOP_BY_HOP_HEADERS.has(lowerName) &&
      lowerName !== "content-length" &&
      lowerName !== "content-encoding" &&
      lowerName !== "set-cookie"
    ) {
      response.setHeader(name, value);
    }
  }
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}

export function createShimServer(config, { fetchImplementation = globalThis.fetch } = {}) {
  return http.createServer(async (request, response) => {
    const incomingUrl = new URL(request.url || "/", "http://shim.invalid");
    if (incomingUrl.pathname === "/health" && request.method === "GET") {
      json(response, 200, {
        status: "shim_ready",
        target: "claude_web",
        upstream_verified: false,
      });
      return;
    }
    if (incomingUrl.pathname !== "/mcp") {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (!authorized(request, config.bearerToken)) {
      response.setHeader("www-authenticate", "Bearer");
      json(response, 401, { error: "unauthorized" });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.connectTimeoutMs);
    request.once("aborted", () => controller.abort());
    try {
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request, config.maxBodyBytes);
      const upstreamUrl = new URL(config.upstreamUrl);
      upstreamUrl.search = incomingUrl.search;
      const upstreamResponse = await fetchImplementation(upstreamUrl, {
        method: request.method,
        headers: upstreamHeaders(request, config),
        ...(body ? { body } : {}),
        signal: controller.signal,
        redirect: "manual",
      });
      clearTimeout(timeout);

      response.statusCode = upstreamResponse.status;
      copyResponseHeaders(upstreamResponse, response);
      if (!upstreamResponse.body) {
        response.end();
        return;
      }
      const stream = Readable.fromWeb(upstreamResponse.body);
      stream.once("error", () => response.destroy());
      stream.pipe(response);
    } catch (error) {
      clearTimeout(timeout);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      json(response, error?.status || (error?.name === "AbortError" ? 504 : 502), {
        error: error?.status === 413 ? "request_too_large" : "upstream_unavailable",
      });
    }
  });
}

export async function startServer(config = configFromEnv()) {
  const server = createShimServer(config);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  process.stderr.write(
    `[claude-web-shim] listening on ${typeof address === "object" ? `${address.address}:${address.port}` : address}; target=claude_web\n`,
  );
  return server;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await startServer();
