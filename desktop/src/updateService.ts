import { EventEmitter } from "node:events";

import {
  RELEASE_OWNER,
  RELEASE_REPOSITORY,
  RELEASES_URL,
} from "./constants";
import { classifyNavigation } from "./navigationPolicy";

export interface ReleaseSummary {
  version: string;
  releaseName?: string;
  releaseDate?: string;
}

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date" }
  | { phase: "available"; release: ReleaseSummary }
  | { phase: "downloading"; percent: number }
  | { phase: "downloaded"; release: ReleaseSummary }
  | { phase: "error"; message: string };

export type UpdateEvent =
  | { type: "check" }
  | { type: "not-available" }
  | { type: "available"; release: ReleaseSummary }
  | { type: "download-started" }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; release: ReleaseSummary }
  | { type: "error"; message: string };

export function reduceUpdateState(
  state: UpdateState,
  event: UpdateEvent,
): UpdateState {
  switch (event.type) {
    case "check":
      return { phase: "checking" };
    case "not-available":
      return { phase: "up-to-date" };
    case "available":
      return { phase: "available", release: event.release };
    case "download-started":
      return state.phase === "available"
        ? { phase: "downloading", percent: 0 }
        : state;
    case "progress":
      return state.phase === "downloading"
        ? {
            phase: "downloading",
            percent: Math.min(100, Math.max(0, event.percent)),
          }
        : state;
    case "downloaded":
      return { phase: "downloaded", release: event.release };
    case "error":
      return { phase: "error", message: event.message };
  }
}

export interface AutoUpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  on(eventName: string, listener: (...args: any[]) => void): unknown;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  setFeedURL(options: {
    provider: "github";
    owner: string;
    repo: string;
  }): void;
}

export type DownloadPromptDecision = "later" | "view-release" | "download";

export interface UpdateServiceDependencies {
  openExternal(url: string): Promise<unknown>;
  promptForDownload(release: ReleaseSummary): Promise<DownloadPromptDecision>;
  promptForInstall(release: ReleaseSummary): Promise<boolean>;
  updater: AutoUpdaterAdapter;
}

interface UpdaterReleaseInfo {
  version?: unknown;
  releaseName?: unknown;
  releaseDate?: unknown;
}

interface UpdaterProgressInfo {
  percent?: unknown;
}

function releaseSummary(info: UpdaterReleaseInfo): ReleaseSummary {
  const version =
    typeof info.version === "string" && info.version.trim() !== ""
      ? info.version
      : "unknown";
  const summary: ReleaseSummary = { version };
  if (typeof info.releaseName === "string") {
    summary.releaseName = info.releaseName;
  }
  if (typeof info.releaseDate === "string") {
    summary.releaseDate = info.releaseDate;
  }
  return summary;
}

function errorMessage(error: unknown): string {
  void error;
  return "Update check unavailable";
}

export class UpdateService extends EventEmitter {
  private currentState: UpdateState = { phase: "idle" };
  private downloadPromptActive = false;
  private installPromptActive = false;
  private started = false;
  private readonly dependencies: UpdateServiceDependencies;

  constructor(dependencies: UpdateServiceDependencies) {
    super();
    this.dependencies = dependencies;
  }

  get state(): UpdateState {
    return this.currentState;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    const { updater } = this.dependencies;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.setFeedURL({
      provider: "github",
      owner: RELEASE_OWNER,
      repo: RELEASE_REPOSITORY,
    });

    updater.on("checking-for-update", () => this.apply({ type: "check" }));
    updater.on("update-not-available", () =>
      this.apply({ type: "not-available" }),
    );
    updater.on("update-available", (info: UpdaterReleaseInfo) => {
      const release = releaseSummary(info);
      this.apply({ type: "available", release });
      void this.handleAvailable(release);
    });
    updater.on("download-progress", (info: UpdaterProgressInfo) => {
      const percent =
        typeof info.percent === "number" && Number.isFinite(info.percent)
          ? info.percent
          : 0;
      this.apply({ type: "progress", percent });
    });
    updater.on("update-downloaded", (info: UpdaterReleaseInfo) => {
      const release = releaseSummary(info);
      this.apply({ type: "downloaded", release });
      void this.handleDownloaded(release);
    });
    updater.on("error", (error: unknown) => {
      this.apply({ type: "error", message: errorMessage(error) });
    });

    void this.checkNow();
  }

  async checkNow(): Promise<void> {
    this.apply({ type: "check" });
    try {
      await this.dependencies.updater.checkForUpdates();
    } catch (error) {
      this.apply({ type: "error", message: errorMessage(error) });
    }
  }

  async openReleasePage(): Promise<void> {
    if (classifyNavigation(RELEASES_URL) !== "open-release-external") {
      throw new Error("Release URL did not pass the navigation policy");
    }
    await this.dependencies.openExternal(RELEASES_URL);
  }

  private apply(event: UpdateEvent): void {
    this.currentState = reduceUpdateState(this.currentState, event);
    this.emit("state", this.currentState);
  }

  private async handleAvailable(release: ReleaseSummary): Promise<void> {
    if (this.downloadPromptActive) {
      return;
    }
    this.downloadPromptActive = true;
    try {
      const decision = await this.dependencies.promptForDownload(release);
      if (decision === "view-release") {
        await this.openReleasePage();
      } else if (decision === "download") {
        this.apply({ type: "download-started" });
        try {
          await this.dependencies.updater.downloadUpdate();
        } catch (error) {
          this.apply({ type: "error", message: errorMessage(error) });
        }
      }
    } catch (error) {
      this.apply({ type: "error", message: errorMessage(error) });
    } finally {
      this.downloadPromptActive = false;
    }
  }

  private async handleDownloaded(release: ReleaseSummary): Promise<void> {
    if (this.installPromptActive) {
      return;
    }
    this.installPromptActive = true;
    try {
      const shouldInstall = await this.dependencies.promptForInstall(release);
      if (shouldInstall) {
        this.dependencies.updater.quitAndInstall(false, true);
      }
    } catch (error) {
      this.apply({ type: "error", message: errorMessage(error) });
    } finally {
      this.installPromptActive = false;
    }
  }
}
