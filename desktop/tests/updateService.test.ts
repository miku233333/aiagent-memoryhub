import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  UpdateService,
  reduceUpdateState,
  type AutoUpdaterAdapter,
} from "../src/updateService";

class FakeUpdater extends EventEmitter implements AutoUpdaterAdapter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  readonly checkForUpdates = vi.fn(async () => undefined);
  readonly downloadUpdate = vi.fn(async () => []);
  readonly quitAndInstall = vi.fn();
  readonly setFeedURL = vi.fn();
}

async function flushAsyncEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("reduceUpdateState", () => {
  it("tracks updater events without treating availability as consent", () => {
    const checking = reduceUpdateState({ phase: "idle" }, { type: "check" });
    const available = reduceUpdateState(checking, {
      type: "available",
      release: { version: "0.2.0" },
    });
    const downloading = reduceUpdateState(available, {
      type: "download-started",
    });
    const progressed = reduceUpdateState(downloading, {
      type: "progress",
      percent: 52.4,
    });
    const downloaded = reduceUpdateState(progressed, {
      type: "downloaded",
      release: { version: "0.2.0" },
    });

    expect(checking).toEqual({ phase: "checking" });
    expect(available).toEqual({
      phase: "available",
      release: { version: "0.2.0" },
    });
    expect(progressed).toEqual({ phase: "downloading", percent: 52.4 });
    expect(downloaded).toEqual({
      phase: "downloaded",
      release: { version: "0.2.0" },
    });
  });

  it("represents no-release and offline outcomes without forcing UI actions", () => {
    expect(
      reduceUpdateState({ phase: "checking" }, { type: "not-available" }),
    ).toEqual({ phase: "up-to-date" });
    expect(
      reduceUpdateState(
        { phase: "checking" },
        { type: "error", message: "offline" },
      ),
    ).toEqual({ phase: "error", message: "offline" });
  });
});

describe("UpdateService", () => {
  it("disables automatic downloads and requires confirmation to download and install", async () => {
    const updater = new FakeUpdater();
    const promptForDownload = vi.fn(async () => "download" as const);
    const promptForInstall = vi.fn(async () => true);
    const service = new UpdateService({
      openExternal: vi.fn(async () => undefined),
      promptForDownload,
      promptForInstall,
      updater,
    });

    service.start();
    await flushAsyncEvents();

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      owner: "miku233333",
      provider: "github",
      repo: "aiagent-memoryhub",
    });
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();

    updater.emit("update-available", { version: "0.2.0" });
    await flushAsyncEvents();
    expect(promptForDownload).toHaveBeenCalledOnce();
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();

    updater.emit("update-downloaded", { version: "0.2.0" });
    await flushAsyncEvents();
    expect(promptForInstall).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("does not download when the user defers and safely opens only the fixed release page", async () => {
    const updater = new FakeUpdater();
    const openExternal = vi.fn(async () => undefined);
    const service = new UpdateService({
      openExternal,
      promptForDownload: vi.fn(async () => "view-release" as const),
      promptForInstall: vi.fn(async () => false),
      updater,
    });

    service.start();
    updater.emit("update-available", { version: "0.2.0" });
    await flushAsyncEvents();

    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/miku233333/aiagent-memoryhub/releases",
    );
  });
});
