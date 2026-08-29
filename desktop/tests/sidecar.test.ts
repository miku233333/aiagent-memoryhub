import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSidecarEnvironment,
  loadOrCreateHubToken,
  reduceSidecarState,
  resolveSidecarLaunchPlan,
} from "../src/sidecar";

describe("resolveSidecarLaunchPlan", () => {
  it("resolves the packaged sidecar and resource paths on macOS", () => {
    const plan = resolveSidecarLaunchPlan({
      appDataPath: "/Users/test/Library/Application Support",
      appPath: "/Applications/AI Agent MemoryHub.app/Contents/Resources/app.asar",
      isPackaged: true,
      platform: "darwin",
      resourcesPath: "/Applications/AI Agent MemoryHub.app/Contents/Resources",
    });

    expect(plan.command).toBe(
      "/Applications/AI Agent MemoryHub.app/Contents/Resources/Backend/ai-agent-memoryhub-sidecar",
    );
    expect(plan.args).toEqual([]);
    expect(plan.webDirectory).toBe(
      "/Applications/AI Agent MemoryHub.app/Contents/Resources/Web",
    );
    expect(plan.databasePath).toBe(
      "/Users/test/Library/Application Support/MemoryHub/memory-hub.sqlite3",
    );
    expect(plan.tokenPath).toBe(
      "/Users/test/Library/Application Support/MemoryHub/hub-token",
    );
  });

  it("uses the .exe artifact on packaged Windows", () => {
    const plan = resolveSidecarLaunchPlan({
      appDataPath: "C:\\Users\\test\\AppData\\Roaming",
      appPath: "C:\\Program Files\\AI Agent MemoryHub\\resources\\app.asar",
      isPackaged: true,
      platform: "win32",
      resourcesPath: "C:\\Program Files\\AI Agent MemoryHub\\resources",
      pathApi: path.win32,
    });

    expect(plan.command).toBe(
      "C:\\Program Files\\AI Agent MemoryHub\\resources\\Backend\\ai-agent-memoryhub-sidecar.exe",
    );
  });

  it("uses the uv workspace fallback during development", () => {
    const plan = resolveSidecarLaunchPlan({
      appDataPath: "/Users/test/Library/Application Support",
      appPath: "/workspace/desktop",
      isPackaged: false,
      platform: "darwin",
      resourcesPath: "/workspace/desktop/node_modules/electron/dist/Electron.app/Contents/Resources",
    });

    expect(plan.command).toBe("uv");
    expect(plan.args).toEqual([
      "run",
      "--no-editable",
      "--reinstall-package",
      "ai-agent-memory-hub",
      "memory-hub",
    ]);
    expect(plan.cwd).toBe("/workspace/backend");
    expect(plan.webDirectory).toBe("/workspace/web/dist");
  });
});

describe("buildSidecarEnvironment", () => {
  it("overrides inherited network and storage settings with fixed local values", () => {
    const plan = resolveSidecarLaunchPlan({
      appDataPath: "/tmp/app-data",
      appPath: "/workspace/desktop",
      isPackaged: false,
      platform: "darwin",
      resourcesPath: "/tmp/resources",
    });

    const environment = buildSidecarEnvironment(
      plan,
      "trusted-generated-token",
      {
        MEMORY_HUB_HOST: "0.0.0.0",
        MEMORY_HUB_PORT: "9999",
        MEMORY_HUB_TOKEN: "attacker-controlled-inherited-value",
      },
    );

    expect(environment.MEMORY_HUB_HOST).toBe("127.0.0.1");
    expect(environment.MEMORY_HUB_PORT).toBe("8787");
    expect(environment.MEMORY_HUB_DATABASE).toBe(plan.databasePath);
    expect(environment.MEMORY_HUB_WEB_DIR).toBe(plan.webDirectory);
    expect(environment.MEMORY_HUB_TOKEN).toBe("trusted-generated-token");
  });
});

describe("loadOrCreateHubToken", () => {
  it("creates one private stable token without returning it to the renderer", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "memoryhub-token-test-"),
    );
    const tokenPath = path.join(temporaryDirectory, "state", "hub-token");

    try {
      const first = loadOrCreateHubToken(tokenPath);
      const second = loadOrCreateHubToken(tokenPath);

      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(second).toBe(first);
      expect(readFileSync(tokenPath, "utf8").trim()).toBe(first);
      if (process.platform !== "win32") {
        expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("rejects malformed persisted credentials", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "memoryhub-token-test-"),
    );
    const tokenPath = path.join(temporaryDirectory, "hub-token");

    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(tokenPath, "not-a-valid-token\n", { mode: 0o600 });
      expect(() => loadOrCreateHubToken(tokenPath)).toThrow(
        "Hub token file is invalid",
      );
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});

describe("reduceSidecarState", () => {
  it("tracks startup, readiness, failure, and shutdown deterministically", () => {
    const starting = reduceSidecarState({ phase: "idle" }, { type: "start" });
    const waiting = reduceSidecarState(starting, { type: "spawned", pid: 321 });
    const ready = reduceSidecarState(waiting, { type: "healthy" });
    const stopped = reduceSidecarState(ready, { type: "stop" });

    expect(starting).toEqual({ phase: "starting" });
    expect(waiting).toEqual({ phase: "waiting-health", pid: 321 });
    expect(ready).toEqual({ phase: "ready", pid: 321 });
    expect(stopped).toEqual({ phase: "stopped" });

    expect(
      reduceSidecarState(starting, { type: "failed", message: "missing sidecar" }),
    ).toEqual({ phase: "failed", message: "missing sidecar" });
  });
});
