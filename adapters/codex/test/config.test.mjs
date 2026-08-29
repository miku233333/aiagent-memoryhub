import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HubClient } from "../src/client.mjs";
import { defaultHubTokenPath, loadConfig } from "../src/config.mjs";

test("scope is taken only from fixed environment variables", () => {
  const config = loadConfig({
    MEMORY_HUB_USER_ID: " user-1 ",
    MEMORY_HUB_PROJECT_ID: " project-a ",
    MEMORY_HUB_PLATFORM: "codex",
  });

  assert.deepEqual(config.scope, {
    user_id: "user-1",
    project_id: "project-a",
  });
  assert.equal(config.url, "http://127.0.0.1:8787");
  assert.equal(config.writeEnabled, false);
});

test("remote plaintext Hub URLs are rejected", () => {
  assert.throws(
    () =>
      loadConfig({
        MEMORY_HUB_USER_ID: "user-1",
        MEMORY_HUB_PLATFORM: "qoder",
        MEMORY_HUB_URL: "http://memory.example.com:8787",
      }),
    /HTTPS/,
  );
});

test("a token file takes precedence over a literal token", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-token-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tokenPath = path.join(directory, "hub-token");
  await fs.writeFile(tokenPath, "shared-file-token\n", { mode: 0o600 });

  for (const platform of ["codex", "qoder", "grok_build", "openclaw"]) {
    const config = loadConfig({
      MEMORY_HUB_USER_ID: "user-1",
      MEMORY_HUB_PLATFORM: platform,
      MEMORY_HUB_TOKEN: "literal-token",
      MEMORY_HUB_TOKEN_FILE: tokenPath,
    });
    assert.equal(config.token, "shared-file-token");
  }

  let authorization;
  const config = loadConfig({
    MEMORY_HUB_USER_ID: "user-1",
    MEMORY_HUB_PLATFORM: "codex",
    MEMORY_HUB_TOKEN_FILE: tokenPath,
  });
  const client = new HubClient(config, async (_url, init) => {
    authorization = new Headers(init.headers).get("authorization");
    return new Response(
      JSON.stringify({
        schema_version: "v1",
        scope: { user_id: "user-1" },
        target: null,
        items: [],
        rendered_content: "",
        setting: null,
        delivery_state: "prepared",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  await client.context({});
  assert.equal(authorization, "Bearer shared-file-token");

  if (process.platform !== "win32") {
    await fs.chmod(tokenPath, 0o644);
    assert.throws(
      () =>
        loadConfig({
          MEMORY_HUB_USER_ID: "user-1",
          MEMORY_HUB_PLATFORM: "codex",
          MEMORY_HUB_TOKEN: "must-not-fallback",
          MEMORY_HUB_TOKEN_FILE: tokenPath,
        }),
      /could not be read securely/u,
    );
  }
});

test("the shared runtime auto-discovers the private desktop token", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-hub-home-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const environment = {
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: path.join(directory, "AppData", "Roaming"),
    XDG_CONFIG_HOME: path.join(directory, ".config"),
    MEMORY_HUB_USER_ID: "user-1",
    MEMORY_HUB_PLATFORM: "codex",
  };
  const tokenPath = defaultHubTokenPath(environment);
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(tokenPath, "desktop-token\n", { mode: 0o600 });

  assert.equal(loadConfig(environment).token, "desktop-token");

  if (process.platform !== "win32") {
    await fs.chmod(tokenPath, 0o644);
    assert.equal(loadConfig(environment).token, undefined);
  }
});
