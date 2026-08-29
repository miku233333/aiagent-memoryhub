import assert from "node:assert/strict";
import test from "node:test";

import { HubClient, HubProtocolError } from "../src/client.mjs";

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function config(overrides = {}) {
  return {
    url: "http://127.0.0.1:8787",
    token: undefined,
    platform: "codex",
    scope: { user_id: "user-1", project_id: "project-a" },
    timeoutMs: 1_000,
    maxItems: 20,
    writeEnabled: false,
    ...overrides,
  };
}

test("context reads approved canonical content without requesting a target projection", async () => {
  let captured;
  const client = new HubClient(config(), async (_url, init) => {
    captured = JSON.parse(init.body);
    return response(200, {
      schema_version: "v1",
      scope: captured.scope,
      target: null,
      items: [
        {
          id: "m-1",
          canonical_content: "Use PostgreSQL",
          rendered_content: "Use PostgreSQL",
          canonical_digest: "same",
          rendered_digest: "same",
          changed: false,
        },
      ],
      rendered_content: "Use PostgreSQL",
      setting: null,
      delivery_state: "prepared",
    });
  });

  const result = await client.context({ query: "database", sessionId: "s-1" });

  assert.equal(result.text, "Use PostgreSQL");
  assert.equal("target" in captured, false);
  assert.deepEqual(captured.scope, config().scope);
  assert.equal(captured.source_platform, "codex");
});

test("context rejects projected responses for non-Claude adapters", async () => {
  const client = new HubClient(config(), async () =>
    response(200, {
      schema_version: "v1",
      scope: config().scope,
      target: "claude_code",
      items: [],
      rendered_content: "rewritten",
      setting: { cross_cultural_polish: true },
      delivery_state: "prepared",
    }),
  );

  await assert.rejects(
    () => client.context({}),
    (error) => error instanceof HubProtocolError && error.code === "projection_echo_refused",
  );
});

test("proposal is always pending and receives an idempotency key", async () => {
  let captured;
  const client = new HubClient(config({ writeEnabled: true }), async (_url, init) => {
    captured = { body: JSON.parse(init.body), headers: new Headers(init.headers) };
    return response(201, { schema_version: "v1", item: { id: "m-1", status: "pending" } });
  });

  const result = await client.propose({
    content: "User prefers concise answers",
    sessionId: "s-1",
    metadata: { source_event: "Stop" },
  });

  assert.equal(result.item.status, "pending");
  assert.equal(captured.body.explicit_user_fact, false);
  assert.equal(captured.body.scope.user_id, "user-1");
  assert.match(captured.headers.get("idempotency-key"), /^[a-f0-9]{64}$/);
});

test("writes remain disabled unless explicitly enabled in environment", async () => {
  const client = new HubClient(config(), async () => {
    throw new Error("fetch should not run");
  });
  await assert.rejects(() => client.checkpoint({ summary: "done" }), /write_disabled/);
});
