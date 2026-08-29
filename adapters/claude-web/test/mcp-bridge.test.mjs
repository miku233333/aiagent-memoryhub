import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bridgeConfigFromEnv, createMcpBridgeServer } from "../src/mcp-bridge.mjs";
import { defaultHubTokenPath } from "../src/config-security.mjs";

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

async function rpc(port, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: response.status === 202 ? undefined : await response.json(),
  };
}

function config(hubUrl, overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    hubUrl,
    hubToken: undefined,
    userId: "user-fixed",
    projectId: "project-fixed",
    bearerToken: undefined,
    trustExternalAuth: false,
    allowedOrigins: new Set(),
    enableWriteTools: false,
    timeoutMs: 1_000,
    maxBodyBytes: 64 * 1024,
    ...overrides,
  };
}

async function fakeHub(t) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    for await (const chunk of request) raw += chunk;
    const parsedBody = raw ? JSON.parse(raw) : undefined;
    requests.push({
      path: request.url,
      body: parsedBody,
      idempotencyKey: request.headers["idempotency-key"],
      target: request.headers["x-memory-sync-target"],
      authorization: request.headers.authorization,
    });
    response.setHeader("content-type", "application/json");

    if (request.url === "/v1/context-pack") {
      response.end(
        JSON.stringify({
          schema_version: "v1",
          target: "claude_web",
          rendered_content: "Internationalized project context",
          items: [
            {
              id: "memory-1",
              canonical_content: "国内项目上下文",
              rendered_content: "Internationalized project context",
              changed: true,
              source_platform: "codex",
              created_at: "2026-08-30T00:00:00Z",
            },
          ],
          setting: { cross_cultural_polish: true },
          delivery_state: "prepared",
        }),
      );
      return;
    }
    if (request.url === "/v1/projections/preview") {
      response.end(
        JSON.stringify({
          schema_version: "v1",
          target: "claude_web",
          canonical_content: request.body?.content,
          rendered_content: "Preview projection",
          changed: true,
        }),
      );
      return;
    }
    if (request.url === "/v1/memory/proposals") {
      response.statusCode = 201;
      response.end(
        JSON.stringify({
          schema_version: "v1",
          item: {
            id: "proposal-1",
            status: parsedBody.explicit_user_fact ? "approved" : "pending",
          },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ detail: { code: "not_found" } }));
  });
  const port = await listen(t, server);
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

test("implements initialize and lists safe read tools by default", async (t) => {
  const hub = await fakeHub(t);
  const bridge = createMcpBridgeServer(config(hub.baseUrl));
  const port = await listen(t, bridge);

  const initialized = await rpc(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.body.result.protocolVersion, "2025-06-18");
  assert.equal(initialized.body.result.serverInfo.name, "ai-memory-sync-claude-web");

  const listed = await rpc(port, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  assert.deepEqual(
    listed.body.result.tools.map((tool) => tool.name),
    ["context_pack", "memory_search", "projection_preview"],
  );
  assert.equal(listed.body.result.tools.every((tool) => tool.annotations.readOnlyHint), true);

  const notification = await rpc(port, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(notification.status, 202);
});

test("context and search calls force fixed scope/target and hide canonical memory", async (t) => {
  const hub = await fakeHub(t);
  const bridge = createMcpBridgeServer(config(hub.baseUrl));
  const port = await listen(t, bridge);

  const called = await rpc(port, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "memory_search", arguments: { query: "project", limit: 5 } },
  });
  assert.equal(called.status, 200);
  assert.equal(called.body.result.isError, undefined);
  assert.equal(
    called.body.result.structuredContent.rendered_content,
    "Internationalized project context",
  );
  assert.doesNotMatch(JSON.stringify(called.body.result), /国内项目上下文/u);

  assert.equal(hub.requests.length, 1);
  assert.equal(hub.requests[0].path, "/v1/context-pack");
  assert.deepEqual(hub.requests[0].body.scope, {
    user_id: "user-fixed",
    project_id: "project-fixed",
  });
  assert.equal(hub.requests[0].body.target, "claude_web");
  assert.equal(hub.requests[0].body.query, "project");
  assert.equal(hub.requests[0].target, "claude_web");
});

test("projection preview is non-persistent and a secret-bearing call fails locally", async (t) => {
  const hub = await fakeHub(t);
  const bridge = createMcpBridgeServer(config(hub.baseUrl));
  const port = await listen(t, bridge);

  const preview = await rpc(port, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "projection_preview", arguments: { content: "国内团队" } },
  });
  assert.equal(preview.body.result.structuredContent.rendered_content, "Preview projection");
  assert.equal(hub.requests[0].path, "/v1/projections/preview");

  const blocked = await rpc(port, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "memory_search",
      arguments: { query: "find api_key=super-secret-value" },
    },
  });
  assert.equal(blocked.body.result.isError, true);
  assert.equal(blocked.body.result.structuredContent.error, "secret_detected");
  assert.equal(hub.requests.length, 1);
});

test("write tools are opt-in and always create pending proposals", async (t) => {
  const hub = await fakeHub(t);
  const bridge = createMcpBridgeServer(
    config(hub.baseUrl, { enableWriteTools: true }),
  );
  const port = await listen(t, bridge);

  const listed = await rpc(port, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/list",
  });
  assert.equal(listed.body.result.tools.at(-1).name, "memory_propose");
  assert.equal(listed.body.result.tools.at(-1).annotations.readOnlyHint, false);
  assert.deepEqual(listed.body.result.tools.at(-1).inputSchema.required, ["content"]);
  assert.equal(
    listed.body.result.tools.at(-1).inputSchema.properties.confirmed_by_user,
    undefined,
  );

  const accepted = await rpc(port, {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "memory_propose",
      // A raw caller can still send an obsolete/model-asserted flag. It must not
      // cross the trust boundary or turn the proposal into an approved fact.
      arguments: { content: "Use PostgreSQL", confirmed_by_user: true },
    },
  });
  assert.equal(accepted.body.result.structuredContent.delivery_state, "accepted");
  assert.equal(accepted.body.result.structuredContent.status, "pending");
  assert.equal(hub.requests[0].body.explicit_user_fact, false);
  assert.equal(hub.requests[0].body.metadata.confirmed_by_user, undefined);
  assert.equal(hub.requests[0].body.scope.user_id, "user-fixed");
  assert.ok(hub.requests[0].idempotencyKey);
});

test("bridge startup requires fixed scope and protects non-loopback/origin access", async (t) => {
  assert.throws(
    () => bridgeConfigFromEnv({}),
    /MEMORY_HUB_USER_ID is required/u,
  );
  assert.throws(
    () =>
      bridgeConfigFromEnv({
        MEMORY_HUB_USER_ID: "user-1",
        CLAUDE_WEB_BRIDGE_HOST: "0.0.0.0",
      }),
    /TRUST_EXTERNAL_AUTH/u,
  );
  assert.throws(
    () =>
      bridgeConfigFromEnv({
        MEMORY_HUB_USER_ID: "user-1",
        CLAUDE_WEB_BRIDGE_HOST: "0.0.0.0",
        CLAUDE_WEB_BRIDGE_BEARER_TOKEN: "static-token-is-not-external-auth",
      }),
    /TRUST_EXTERNAL_AUTH/u,
  );
  assert.equal(
    bridgeConfigFromEnv({
      MEMORY_HUB_USER_ID: "user-1",
      CLAUDE_WEB_BRIDGE_HOST: "0.0.0.0",
      CLAUDE_WEB_BRIDGE_TRUST_EXTERNAL_AUTH: "1",
    }).trustExternalAuth,
    true,
  );

  for (const unsafeUrl of [
    "http://memory.example.com:8787",
    "https://user:secret@memory.example.com",
  ]) {
    assert.throws(
      () => bridgeConfigFromEnv({ MEMORY_HUB_USER_ID: "user-1", MEMORY_HUB_URL: unsafeUrl }),
      /HTTPS|must not contain credentials/u,
    );
  }

  const hub = await fakeHub(t);
  const bridge = createMcpBridgeServer(config(hub.baseUrl));
  const port = await listen(t, bridge);
  const rejected = await rpc(
    port,
    { jsonrpc: "2.0", id: 9, method: "ping" },
    { origin: "https://evil.example" },
  );
  assert.equal(rejected.status, 403);

  const getResponse = await fetch(`http://127.0.0.1:${port}/mcp`);
  assert.equal(getResponse.status, 405);
});

test("the bridge prefers a bounded token file over a literal token", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-token-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tokenPath = path.join(directory, "hub-token");
  await fs.writeFile(tokenPath, "bridge-file-token\n", { mode: 0o600 });
  const hub = await fakeHub(t);

  const config = bridgeConfigFromEnv({
    MEMORY_HUB_USER_ID: "user-1",
    MEMORY_HUB_URL: hub.baseUrl,
    MEMORY_HUB_TOKEN: "literal-token",
    MEMORY_HUB_TOKEN_FILE: tokenPath,
  });
  assert.equal(config.hubToken, "bridge-file-token");

  const bridge = createMcpBridgeServer(config);
  const port = await listen(t, bridge);
  await rpc(port, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "context_pack", arguments: {} },
  });
  assert.equal(hub.requests[0].authorization, "Bearer bridge-file-token");

  if (process.platform !== "win32") {
    await fs.chmod(tokenPath, 0o644);
    assert.throws(
      () =>
        bridgeConfigFromEnv({
          MEMORY_HUB_USER_ID: "user-1",
          MEMORY_HUB_TOKEN: "must-not-fallback",
          MEMORY_HUB_TOKEN_FILE: tokenPath,
        }),
      /could not be read securely/u,
    );
  }
});

test("the bridge auto-discovers the private desktop token", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-home-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const environment = {
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: path.join(directory, "AppData", "Roaming"),
    XDG_CONFIG_HOME: path.join(directory, ".config"),
    MEMORY_HUB_USER_ID: "user-1",
  };
  const tokenPath = defaultHubTokenPath(environment);
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(tokenPath, "desktop-token\n", { mode: 0o600 });

  assert.equal(bridgeConfigFromEnv(environment).hubToken, "desktop-token");
});
