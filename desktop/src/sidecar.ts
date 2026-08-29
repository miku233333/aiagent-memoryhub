import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import {
  HUB_HEALTH_URL,
  HUB_HOST,
  HUB_PORT,
  SIDECAR_BASENAME,
} from "./constants";

type PathApi = Pick<typeof path, "dirname" | "join" | "resolve">;

export interface SidecarRuntimePaths {
  appDataPath: string;
  appPath: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath: string;
  pathApi?: PathApi;
}

export interface SidecarLaunchPlan {
  args: string[];
  command: string;
  cwd?: string;
  databasePath: string;
  isPackaged: boolean;
  tokenPath: string;
  webDirectory: string;
}

export type SidecarState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "waiting-health"; pid: number }
  | { phase: "ready"; pid: number }
  | { phase: "failed"; message: string }
  | { phase: "stopped" };

export type SidecarEvent =
  | { type: "start" }
  | { type: "spawned"; pid: number }
  | { type: "healthy" }
  | { type: "failed"; message: string }
  | { type: "stop" };

export function resolveSidecarLaunchPlan(
  runtime: SidecarRuntimePaths,
): SidecarLaunchPlan {
  const pathApi = runtime.pathApi ?? path;
  const databasePath = pathApi.join(
    runtime.appDataPath,
    "MemoryHub",
    "memory-hub.sqlite3",
  );
  const tokenPath = pathApi.join(
    runtime.appDataPath,
    "MemoryHub",
    "hub-token",
  );

  if (runtime.isPackaged) {
    const executableName =
      runtime.platform === "win32"
        ? `${SIDECAR_BASENAME}.exe`
        : SIDECAR_BASENAME;
    return {
      args: [],
      command: pathApi.join(
        runtime.resourcesPath,
        "Backend",
        executableName,
      ),
      databasePath,
      isPackaged: true,
      tokenPath,
      webDirectory: pathApi.join(runtime.resourcesPath, "Web"),
    };
  }

  const workspaceRoot = pathApi.resolve(runtime.appPath, "..");
  return {
    args: [
      "run",
      "--no-editable",
      "--reinstall-package",
      "ai-agent-memory-hub",
      "memory-hub",
    ],
    command: "uv",
    cwd: pathApi.join(workspaceRoot, "backend"),
    databasePath,
    isPackaged: false,
    tokenPath,
    webDirectory: pathApi.join(workspaceRoot, "web", "dist"),
  };
}

const HUB_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function readHubToken(tokenPath: string): string {
  const pathStats = lstatSync(tokenPath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error("Hub token path must be a regular file");
  }

  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const descriptor = openSync(tokenPath, fsConstants.O_RDONLY | noFollow);
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error("Hub token path must be a regular file");
    }
    const token = readFileSync(descriptor, "utf8").trim();
    if (!HUB_TOKEN_PATTERN.test(token)) {
      throw new Error("Hub token file is invalid");
    }
    if (process.platform !== "win32") {
      chmodSync(tokenPath, 0o600);
    }
    return token;
  } finally {
    closeSync(descriptor);
  }
}

export function loadOrCreateHubToken(tokenPath: string): string {
  const directory = path.dirname(tokenPath);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  if (process.platform !== "win32") {
    chmodSync(directory, 0o700);
  }

  try {
    return readHubToken(tokenPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const token = randomBytes(32).toString("base64url");
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      tokenPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        noFollow,
      0o600,
    );
    writeFileSync(descriptor, `${token}\n`, "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readHubToken(tokenPath);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  return token;
}

export function buildSidecarEnvironment(
  plan: SidecarLaunchPlan,
  hubToken: string,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...inheritedEnvironment,
    MEMORY_HUB_DATABASE: plan.databasePath,
    MEMORY_HUB_HOST: HUB_HOST,
    MEMORY_HUB_PORT: String(HUB_PORT),
    MEMORY_HUB_TOKEN: hubToken,
    MEMORY_HUB_WEB_DIR: plan.webDirectory,
  };
}

export function reduceSidecarState(
  state: SidecarState,
  event: SidecarEvent,
): SidecarState {
  switch (event.type) {
    case "start":
      return { phase: "starting" };
    case "spawned":
      return state.phase === "starting"
        ? { phase: "waiting-health", pid: event.pid }
        : state;
    case "healthy":
      return state.phase === "waiting-health"
        ? { phase: "ready", pid: state.pid }
        : state;
    case "failed":
      return { phase: "failed", message: event.message };
    case "stop":
      return { phase: "stopped" };
  }
}

export interface SidecarControllerOptions {
  hubToken: string;
  launchPlan: SidecarLaunchPlan;
  startupTimeoutMs?: number;
}

export class HubProcessController extends EventEmitter {
  private child: ChildProcess | undefined;
  private readonly launchPlan: SidecarLaunchPlan;
  private readonly hubToken: string;
  private readonly startupTimeoutMs: number;
  private stopping = false;
  private currentState: SidecarState = { phase: "idle" };

  constructor(options: SidecarControllerOptions) {
    super();
    this.launchPlan = options.launchPlan;
    this.hubToken = options.hubToken;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20_000;
  }

  get state(): SidecarState {
    return this.currentState;
  }

  async start(): Promise<void> {
    if (
      this.currentState.phase === "starting" ||
      this.currentState.phase === "waiting-health" ||
      this.currentState.phase === "ready"
    ) {
      return;
    }

    this.stopping = false;
    this.apply({ type: "start" });

    try {
      if (this.launchPlan.isPackaged && !existsSync(this.launchPlan.command)) {
        throw new Error(`Sidecar not found: ${this.launchPlan.command}`);
      }
      mkdirSync(path.dirname(this.launchPlan.databasePath), { recursive: true });
      await assertHubPortAvailable();

      this.child = spawn(this.launchPlan.command, this.launchPlan.args, {
        cwd: this.launchPlan.cwd,
        env: buildSidecarEnvironment(
          this.launchPlan,
          this.hubToken,
          process.env,
        ),
        stdio: "ignore",
        windowsHide: true,
      });
      const spawnedChild = this.child;
      spawnedChild.once("exit", (code, signal) => {
        if (this.stopping || this.child !== spawnedChild) {
          return;
        }
        const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
        this.apply({
          type: "failed",
          message: `Sidecar exited unexpectedly (${detail})`,
        });
      });
      spawnedChild.once("error", (error) => {
        if (!this.stopping && this.child === spawnedChild) {
          this.apply({ type: "failed", message: error.message });
        }
      });

      const pid = spawnedChild.pid;
      if (pid === undefined) {
        this.child = undefined;
        throw new Error("Sidecar process did not provide a process id");
      }

      this.apply({ type: "spawned", pid });
      await this.waitUntilHealthy();
      if (this.child.exitCode !== null || this.currentState.phase === "failed") {
        throw new Error("Sidecar exited before becoming healthy");
      }
      this.apply({ type: "healthy" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.apply({ type: "failed", message });
      await this.terminateOwnedProcess();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.terminateOwnedProcess();
    this.apply({ type: "stop" });
  }

  stopImmediately(): void {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    if (child !== undefined && child.exitCode === null) {
      child.kill();
    }
    this.apply({ type: "stop" });
  }

  private apply(event: SidecarEvent): void {
    this.currentState = reduceSidecarState(this.currentState, event);
    this.emit("state", this.currentState);
  }

  private async waitUntilHealthy(): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastFailure = "health endpoint did not respond";

    while (Date.now() < deadline) {
      const failureMessage = this.failureMessage();
      if (failureMessage !== undefined) {
        throw new Error(failureMessage);
      }
      if (this.child === undefined || this.child.exitCode !== null) {
        throw new Error("Sidecar exited before its health check completed");
      }

      try {
        const response = await fetch(HUB_HEALTH_URL, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          const payload = (await response.json()) as Record<string, unknown>;
          if (
            payload.status === "ok" &&
            payload.service === "memory-hub" &&
            payload.schema_version === "v1"
          ) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            if (
              this.child === undefined ||
              this.child.exitCode !== null ||
              this.failureMessage() !== undefined
            ) {
              throw new Error(
                "Sidecar exited during health-check stabilization; another process may own the Hub port",
              );
            }
            return;
          }
          lastFailure = "health endpoint returned an unexpected service identity";
        } else {
          lastFailure = `health endpoint returned HTTP ${response.status}`;
        }
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    throw new Error(`Sidecar startup timed out: ${lastFailure}`);
  }

  private async terminateOwnedProcess(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child === undefined || child.exitCode !== null) {
      return;
    }

    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private failureMessage(): string | undefined {
    return this.currentState.phase === "failed"
      ? this.currentState.message
      : undefined;
  }
}

export function assertHubPortAvailable(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Local Hub port ${HUB_HOST}:${HUB_PORT} is already in use. Close the existing MemoryHub process and retry.`,
          ),
        );
      } else {
        reject(
          new Error(
            `Unable to reserve local Hub port ${HUB_HOST}:${HUB_PORT} (${error.code ?? "unknown error"})`,
          ),
        );
      }
    });
    server.listen(
      { exclusive: true, host: HUB_HOST, port: HUB_PORT },
      () => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(new Error("Unable to release the local Hub port probe"));
          }
        });
      },
    );
  });
}
