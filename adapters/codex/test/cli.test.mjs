import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.mjs";

function sink() {
  let value = "";
  return {
    write(chunk) {
      value += String(chunk);
    },
    value() {
      return value;
    },
  };
}

const baseEnv = {
  MEMORY_HUB_USER_ID: "user-1",
  MEMORY_HUB_PLATFORM: "codex",
};

test("write commands are dry-run by default and never echo content", async () => {
  const stdout = sink();
  let fetched = false;
  const exitCode = await runCli(["propose"], {
    environment: baseEnv,
    stdinText: "Sensitive preference text",
    stdout,
    stderr: sink(),
    fetchImplementation: async () => {
      fetched = true;
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(fetched, false);
  assert.doesNotMatch(stdout.value(), /Sensitive preference text/);
  assert.deepEqual(JSON.parse(stdout.value()), {
    command: "propose",
    content_length: 25,
    mode: "dry-run",
    would_send: false,
  });
});

test("scope flags are rejected because scope can only come from environment", async () => {
  const stderr = sink();
  const exitCode = await runCli(["context", "--user-id", "other-user"], {
    environment: baseEnv,
    stdinText: "",
    stdout: sink(),
    stderr,
  });

  assert.equal(exitCode, 2);
  assert.match(stderr.value(), /scope_env_only/);
});
