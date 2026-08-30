import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createMemoryHubSession,
  MEMORY_HUB_SESSION_PARTITION,
} from "../src/sessionPolicy";

describe("MemoryHub browser session policy", () => {
  it("keeps disk cookie encryption disabled because the app has no disk cookie store", () => {
    const packageConfig = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      build: { electronFuses: { enableCookieEncryption: boolean } };
    };

    expect(packageConfig.build.electronFuses.enableCookieEncryption).toBe(false);
  });

  it("creates an in-memory session with disk caching disabled", () => {
    const createdSession = {
      getStoragePath: () => null,
      isPersistent: () => false,
      name: "memoryhub-session",
    };
    const calls: Array<{
      options: { cache: boolean };
      partition: string;
    }> = [];

    const result = createMemoryHubSession({
      fromPartition(partition, options) {
        calls.push({ options, partition });
        return createdSession;
      },
    });

    expect(MEMORY_HUB_SESSION_PARTITION).not.toMatch(/^persist:/u);
    expect(calls).toEqual([
      {
        options: { cache: false },
        partition: MEMORY_HUB_SESSION_PARTITION,
      },
    ]);
    expect(result).toBe(createdSession);
  });

  it("fails closed if Electron returns a persistent session", () => {
    expect(() =>
      createMemoryHubSession({
        fromPartition: () => ({
          getStoragePath: () => "/tmp/unexpected-session",
          isPersistent: () => true,
        }),
      }),
    ).toThrow("MemoryHub renderer session must be in-memory");
  });

  it("fails closed if an in-memory session exposes a storage path", () => {
    expect(() =>
      createMemoryHubSession({
        fromPartition: () => ({
          getStoragePath: () => "/tmp/unexpected-session",
          isPersistent: () => false,
        }),
      }),
    ).toThrow("MemoryHub renderer session must not have a storage path");
  });

  it("wires the same explicit session into security policy and BrowserWindow", () => {
    const mainSource = readFileSync(
      path.join(process.cwd(), "src", "main.ts"),
      "utf8",
    );

    expect(mainSource).not.toContain("session.defaultSession");
    expect(mainSource).toContain("createMemoryHubSession(session)");
    expect(mainSource).toContain("configureSessionSecurity(applicationSession");
    expect(mainSource).toContain("createMainWindow(applicationSession)");
    expect(mainSource).toContain("session: applicationSession");
    expect(mainSource).toContain(
      "mainWindow.webContents.session !== applicationSession",
    );
  });
});
