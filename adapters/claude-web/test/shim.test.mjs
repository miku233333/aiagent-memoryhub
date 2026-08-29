import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configFromEnv, createShimServer } from "../src/server.mjs";

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

test("proxies MCP requests and marks the target as claude_web", async (t) => {
  let received;
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    received = {
      body,
      target: request.headers["x-memory-sync-target"],
      accept: request.headers.accept,
      session: request.headers["mcp-session-id"],
    };
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("mcp-session-id", "server-session");
    response.end("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n");
  });
  const upstreamPort = await listen(t, upstream);
  const shim = createShimServer({
    upstreamUrl: new URL(`http://127.0.0.1:${upstreamPort}/mcp`),
    connectTimeoutMs: 1_000,
    maxBodyBytes: 64 * 1024,
  });
  const shimPort = await listen(t, shim);

  const response = await fetch(`http://127.0.0.1:${shimPort}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": "client-session",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("mcp-session-id"), "server-session");
  assert.match(await response.text(), /event: message/u);
  assert.equal(received.target, "claude_web");
  assert.equal(received.session, "client-session");
  assert.match(received.accept, /text\/event-stream/u);
  assert.match(received.body, /initialize/u);
});

test("optional local bearer gate rejects an unauthenticated caller", async (t) => {
  let upstreamCalled = false;
  const shim = createShimServer(
    {
      upstreamUrl: new URL("http://127.0.0.1:1/mcp"),
      bearerToken: "test-only-token",
      connectTimeoutMs: 100,
      maxBodyBytes: 4096,
    },
    {
      fetchImplementation: async () => {
        upstreamCalled = true;
        return new Response("{}", { status: 200 });
      },
    },
  );
  const port = await listen(t, shim);
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
  assert.equal(response.status, 401);
  assert.equal(upstreamCalled, false);
});

test("a shim-only bearer credential is not forwarded upstream", async (t) => {
  let forwardedAuthorization;
  const shim = createShimServer(
    {
      upstreamUrl: new URL("http://hub.invalid/mcp"),
      bearerToken: "shim-token",
      connectTimeoutMs: 100,
      maxBodyBytes: 4096,
    },
    {
      fetchImplementation: async (_url, options) => {
        forwardedAuthorization = options.headers.get("authorization");
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  const port = await listen(t, shim);
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer shim-token" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal(forwardedAuthorization, null);
});

test("does not expose an unauthenticated listener on a non-loopback interface", () => {
  assert.throws(
    () =>
      configFromEnv({
        CLAUDE_WEB_SHIM_HOST: "0.0.0.0",
        HUB_MCP_URL: "http://127.0.0.1:8787/mcp",
      }),
    /TRUST_EXTERNAL_AUTH/u,
  );
  assert.throws(
    () =>
      configFromEnv({
        CLAUDE_WEB_SHIM_HOST: "0.0.0.0",
        CLAUDE_WEB_SHIM_BEARER_TOKEN: "static-token-is-not-external-auth",
        HUB_MCP_URL: "http://127.0.0.1:8787/mcp",
      }),
    /TRUST_EXTERNAL_AUTH/u,
  );
  assert.equal(
    configFromEnv({
      CLAUDE_WEB_SHIM_HOST: "0.0.0.0",
      CLAUDE_WEB_SHIM_TRUST_EXTERNAL_AUTH: "true",
      HUB_MCP_URL: "http://127.0.0.1:8787/mcp",
    }).trustExternalAuth,
    true,
  );
});

test("proxy URLs reject credentials and remote plaintext", () => {
  assert.throws(
    () => configFromEnv({ HUB_MCP_URL: "http://memory.example.com/mcp" }),
    /HTTPS/u,
  );
  assert.throws(
    () => configFromEnv({ HUB_MCP_URL: "https://user:secret@memory.example.com/mcp" }),
    /must not contain credentials/u,
  );
  assert.equal(configFromEnv({ HUB_MCP_URL: "http://[::1]:8787/mcp" }).upstreamUrl.href,
    "http://[::1]:8787/mcp");
});

test("the proxy prefers a token file over a literal token", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-token-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tokenPath = path.join(directory, "hub-token");
  await fs.writeFile(tokenPath, "proxy-file-token\n", { mode: 0o600 });

  const config = configFromEnv({
    HUB_MCP_URL: "http://127.0.0.1:8787/mcp",
    MEMORY_HUB_TOKEN: "literal-token",
    MEMORY_HUB_TOKEN_FILE: tokenPath,
  });
  assert.equal(config.upstreamToken, "proxy-file-token");
});
