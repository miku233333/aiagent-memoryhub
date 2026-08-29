import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { defaultHubTokenPath, loadConfig } from "../src/config.mjs";
import { containsRecognizedSecret, protectText } from "../src/redact.mjs";

test("configuration requires an explicit, valid user scope", () => {
  assert.throws(() => loadConfig({}), /MEMORY_HUB_USER_ID is required/u);
  assert.throws(
    () => loadConfig({ MEMORY_HUB_USER_ID: "bad\nuser" }),
    /MEMORY_HUB_USER_ID is invalid/u,
  );

  const config = loadConfig({
    MEMORY_HUB_USER_ID: "user-1",
    MEMORY_HUB_PROJECT_ID: "project-1",
  });
  assert.equal(config.target, "claude_code");
  assert.equal(config.transcriptMode, "redacted");
  assert.equal(config.secretMode, "strict");
});

test("Hub URLs reject embedded credentials and remote plaintext transport", () => {
  const base = { MEMORY_HUB_USER_ID: "user-1" };
  for (const unsafeUrl of ["http://memory.example.com:8787", "http://2130706433:8787"]) {
    assert.throws(() => loadConfig({ ...base, MEMORY_HUB_URL: unsafeUrl }), /HTTPS/u);
  }
  assert.throws(
    () => loadConfig({ ...base, MEMORY_HUB_URL: "https://user:secret@memory.example.com" }),
    /must not contain credentials/u,
  );
  assert.equal(
    loadConfig({ ...base, MEMORY_HUB_URL: "http://localhost:8787" }).hubUrl,
    "http://localhost:8787",
  );
  assert.equal(
    loadConfig({ ...base, MEMORY_HUB_URL: "http://[::1]:8787" }).hubUrl,
    "http://[::1]:8787",
  );
  assert.equal(
    loadConfig({ ...base, MEMORY_HUB_URL: "https://memory.example.com" }).hubUrl,
    "https://memory.example.com",
  );
});

test("a token file takes precedence over a literal token", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-token-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tokenPath = path.join(directory, "hub-token");
  await fs.writeFile(tokenPath, "token-from-file\n", { mode: 0o600 });

  const config = loadConfig({
    MEMORY_HUB_USER_ID: "user-1",
    MEMORY_HUB_TOKEN: "literal-token",
    MEMORY_HUB_TOKEN_FILE: tokenPath,
  });
  assert.equal(config.token, "token-from-file");

  if (process.platform !== "win32") {
    await fs.chmod(tokenPath, 0o644);
    assert.throws(
      () =>
        loadConfig({
          MEMORY_HUB_USER_ID: "user-1",
          MEMORY_HUB_TOKEN: "must-not-fallback",
          MEMORY_HUB_TOKEN_FILE: tokenPath,
        }),
      /could not be read securely/u,
    );
  }
});

test("the desktop token is discovered only when no credential override is set", async (t) => {
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

  assert.equal(loadConfig(environment).token, "desktop-token");
  assert.equal(
    loadConfig({ ...environment, MEMORY_HUB_TOKEN: "literal-token" }).token,
    "literal-token",
  );
});

test("strict secret mode drops a complete message", () => {
  const text = "use api_key=super-secret-value in the request";
  assert.equal(containsRecognizedSecret(text), true);
  assert.deepEqual(protectText(text, "strict"), {
    text: "",
    dropped: true,
    secretDetected: true,
  });
});

test("redact secret mode masks recognized values without changing other text", () => {
  const result = protectText("header: Bearer abcdefghijklmnopqrstuvwxyz", "redact");
  assert.equal(result.dropped, false);
  assert.equal(result.secretDetected, true);
  assert.equal(result.text, "header: [REDACTED_SECRET]");
  assert.equal(protectText("canonical 中文 text", "redact").text, "canonical 中文 text");
});

test("the hook executable fails open with one valid JSON object", () => {
  const executable = fileURLToPath(new URL("../bin/hook.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [executable], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "session-1" }),
    encoding: "utf8",
    env: {},
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(result.stderr, "");
});
