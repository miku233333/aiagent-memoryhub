import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";
import { handleHook } from "../src/hook-handler.mjs";
import { readCursor } from "../src/state-store.mjs";

function transcriptLine(role, text) {
  return `${JSON.stringify({ type: role, message: { role, content: [{ type: "text", text }] } })}\n`;
}

async function startHub(t) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    for await (const chunk of request) raw += chunk;
    requests.push({
      path: request.url,
      body: raw ? JSON.parse(raw) : undefined,
      idempotencyKey: request.headers["idempotency-key"],
      target: request.headers["x-memory-sync-target"],
      authorization: request.headers.authorization,
    });

    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/context-pack") {
      response.end(
        JSON.stringify({
          schema_version: "v1",
          target: "claude_code",
          rendered_content: "Rendered once by the Hub: 偏好保留原文",
        }),
      );
      return;
    }
    response.statusCode = 201;
    response.end(JSON.stringify({ schema_version: "v1", ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, requests };
}

test("injects rendered Hub context and checkpoints each transcript range once", async (t) => {
  const { server, requests } = await startHub(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-sync-hook-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, "session.jsonl");
  await fs.writeFile(
    transcriptPath,
    [
      transcriptLine("user", "记住：这个项目使用 PostgreSQL"),
      transcriptLine("assistant", "了解，我会按项目上下文处理。"),
    ].join(""),
    "utf8",
  );

  const address = server.address();
  const tokenPath = path.join(directory, "hub-token");
  await fs.writeFile(tokenPath, "integration-token\n", { mode: 0o600 });
  const config = loadConfig(
    {
      MEMORY_HUB_URL: `http://127.0.0.1:${address.port}`,
      MEMORY_HUB_TOKEN_FILE: tokenPath,
      MEMORY_HUB_USER_ID: "user-1",
      MEMORY_HUB_PROJECT_ID: "project-1",
      MEMORY_HUB_TIMEOUT_MS: "1000",
    },
    { stateDir: path.join(directory, "state") },
  );

  const injected = await handleHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      prompt: "continue",
    },
    config,
  );
  assert.match(injected.hookSpecificOutput.additionalContext, /偏好保留原文/u);
  assert.equal(injected.hookSpecificOutput.hookEventName, "UserPromptSubmit");

  await handleHook(
    {
      hook_event_name: "Stop",
      session_id: "session-1",
      transcript_path: transcriptPath,
    },
    config,
  );
  await handleHook(
    {
      hook_event_name: "SessionEnd",
      session_id: "session-1",
      transcript_path: transcriptPath,
    },
    config,
  );

  assert.equal(requests.filter((request) => request.path === "/v1/context-pack").length, 1);
  assert.equal(requests.filter((request) => request.path === "/v1/checkpoints").length, 1);
  assert.equal(requests.filter((request) => request.path === "/v1/memory/proposals").length, 1);

  const contextRequest = requests.find((request) => request.path === "/v1/context-pack");
  assert.equal(contextRequest.body.target, "claude_code");
  assert.deepEqual(contextRequest.body.scope, { user_id: "user-1", project_id: "project-1" });
  assert.equal(contextRequest.target, "claude_code");
  assert.equal(requests.every((request) => request.authorization === "Bearer integration-token"), true);

  const checkpoint = requests.find((request) => request.path === "/v1/checkpoints");
  assert.doesNotMatch(JSON.stringify(checkpoint.body), new RegExp(transcriptPath, "u"));
  assert.match(checkpoint.body.summary, /项目使用 PostgreSQL/u);
  assert.ok(checkpoint.idempotencyKey);

  const proposal = requests.find((request) => request.path === "/v1/memory/proposals");
  assert.equal(proposal.body.content, "这个项目使用 PostgreSQL");
  assert.equal(proposal.body.explicit_user_fact, true);
  assert.ok(proposal.idempotencyKey);
});

test("a Hub failure is fail-open and leaves the cursor retryable", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-sync-retry-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, "session.jsonl");
  await fs.writeFile(transcriptPath, transcriptLine("assistant", "safe summary"), "utf8");
  const stateDir = path.join(directory, "state");
  const config = loadConfig(
    {
      MEMORY_HUB_URL: "http://127.0.0.1:1",
      MEMORY_HUB_USER_ID: "user-1",
      MEMORY_HUB_TIMEOUT_MS: "100",
    },
    { stateDir },
  );

  const result = await handleHook(
    {
      hook_event_name: "Stop",
      session_id: "session-retry",
      transcript_path: transcriptPath,
    },
    config,
  );
  assert.deepEqual(result, {});
  assert.equal(await readCursor(stateDir, "session-retry", transcriptPath), 0);
});

test("strict secret mode never sends a secret-bearing prompt as the context query", async () => {
  let body;
  const config = loadConfig({ MEMORY_HUB_USER_ID: "user-1" });
  const client = {
    async contextPack(input) {
      body = input;
      return "safe context";
    },
  };

  await handleHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-secret",
      prompt: "debug api_key=super-secret-value",
    },
    config,
    { client },
  );
  assert.equal(body.query, undefined);
});

test("an authoritative Hub secret rejection consumes the unsafe range", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-sync-hub-secret-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, "session.jsonl");
  await fs.writeFile(transcriptPath, transcriptLine("assistant", "backend-only detector"), "utf8");
  const stateDir = path.join(directory, "state");
  const config = loadConfig({ MEMORY_HUB_USER_ID: "user-1" }, { stateDir });
  const rejection = Object.assign(new Error("blocked"), {
    status: 422,
    code: "secret_detected",
  });
  const client = {
    checkpoint: async () => {
      throw rejection;
    },
    propose: async () => {},
  };

  await handleHook(
    {
      hook_event_name: "Stop",
      session_id: "session-hub-secret",
      transcript_path: transcriptPath,
    },
    config,
    { client },
  );
  assert.equal(
    await readCursor(stateDir, "session-hub-secret", transcriptPath),
    Buffer.byteLength(transcriptLine("assistant", "backend-only detector")),
  );
});

test("a truncated transcript resets and exports from the new file", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-sync-rotation-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, "session.jsonl");
  const oldTranscript = `${transcriptLine("assistant", "old ".repeat(100))}${transcriptLine("assistant", "old tail")}`;
  await fs.writeFile(transcriptPath, oldTranscript, "utf8");
  const stateDir = path.join(directory, "state");
  const config = loadConfig({ MEMORY_HUB_USER_ID: "user-1" }, { stateDir });
  const checkpoints = [];
  const client = {
    checkpoint: async (request) => checkpoints.push(request),
    propose: async () => {},
  };

  await handleHook(
    { hook_event_name: "Stop", session_id: "rotated", transcript_path: transcriptPath },
    config,
    { client },
  );
  const replacement = transcriptLine("assistant", "new file");
  await fs.writeFile(transcriptPath, replacement, "utf8");
  await handleHook(
    { hook_event_name: "Stop", session_id: "rotated", transcript_path: transcriptPath },
    config,
    { client },
  );

  assert.equal(checkpoints.length, 2);
  assert.match(checkpoints[1].summary, /new file/u);
  assert.equal(await readCursor(stateDir, "rotated", transcriptPath), Buffer.byteLength(replacement));
});

test("cursor state cannot continue under a different user scope", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-sync-scope-bind-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, "session.jsonl");
  await fs.writeFile(transcriptPath, transcriptLine("assistant", "first scope"), "utf8");
  const stateDir = path.join(directory, "state");
  let calls = 0;
  const client = {
    checkpoint: async () => {
      calls += 1;
    },
    propose: async () => {},
  };
  const firstConfig = loadConfig({ MEMORY_HUB_USER_ID: "user-1" }, { stateDir });
  await handleHook(
    { hook_event_name: "Stop", session_id: "scope-session", transcript_path: transcriptPath },
    firstConfig,
    { client },
  );
  await fs.appendFile(transcriptPath, transcriptLine("assistant", "must not cross scope"), "utf8");

  const secondConfig = loadConfig({ MEMORY_HUB_USER_ID: "user-2" }, { stateDir });
  await handleHook(
    { hook_event_name: "Stop", session_id: "scope-session", transcript_path: transcriptPath },
    secondConfig,
    { client },
  );
  assert.equal(calls, 1);
});
