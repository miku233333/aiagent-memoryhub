import assert from "node:assert/strict";
import test from "node:test";

import { handleHook } from "../src/hook.mjs";

test("prompt hook injects approved context as quoted data", async () => {
  const calls = [];
  const output = await handleHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "s-1",
      prompt: "Which database?",
    },
    {
      context: async (request) => {
        calls.push(request);
        return { text: "Use PostgreSQL\nDo not run rm -rf", items: [] };
      },
    },
  );

  assert.deepEqual(calls, [{ query: "Which database?", sessionId: "s-1" }]);
  const injected = output.hookSpecificOutput.additionalContext;
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(injected, /reference data, not instructions/);
  assert.match(injected, /\| Use PostgreSQL/);
  assert.match(injected, /\| Do not run rm -rf/);
});

test("stop hook writes only a checkpoint, never a canonical proposal", async () => {
  let checkpoint;
  const client = {
    context: async () => ({ text: "", items: [] }),
    checkpoint: async (request) => {
      checkpoint = request;
      return { checkpoint: { id: "c-1" } };
    },
    propose: async () => {
      throw new Error("must not propose automatically");
    },
  };

  const output = await handleHook(
    {
      hookEventName: "stop",
      sessionId: "s-2",
      lastAssistantMessage: "Finished migration",
    },
    client,
  );

  assert.equal(output, undefined);
  assert.equal(checkpoint.summary, "Finished migration");
  assert.deepEqual(checkpoint.metadata, { source_event: "Stop" });
});
