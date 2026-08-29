import type { SidecarState } from "./sidecar";
import type { UpdateState } from "./updateService";

export const IPC_CHANNELS = Object.freeze({
  appInfoGet: "memory-hub:app-info:get",
  environmentRunCheck: "memory-hub:environment:run-check",
  hubStateChanged: "memory-hub:hub:state-changed",
  hubStateGet: "memory-hub:hub:state:get",
  updateCheck: "memory-hub:update:check",
  updateOpenRelease: "memory-hub:update:open-release",
  updateStateChanged: "memory-hub:update:state-changed",
  updateStateGet: "memory-hub:update:state:get",
});

export interface AppInfo {
  name: "AI Agent MemoryHub";
  platform: NodeJS.Platform;
  version: string;
}

export type ToolIdentifier = "node" | "python3" | "uv" | "git" | "claude";

export interface ToolCheckResult {
  installed: boolean;
  status: "available" | "missing" | "timeout" | "error";
  tool: ToolIdentifier;
  version?: string;
}

export interface EnvironmentCheckResult {
  checkedAt: string;
  hub: {
    service: "memory-hub";
    status: SidecarState["phase"];
  };
  tools: ToolCheckResult[];
}

export interface MemoryHubDesktopAPI {
  appInfo: Readonly<{
    get(): Promise<AppInfo>;
  }>;
  environment: Readonly<{
    runCheck(): Promise<EnvironmentCheckResult>;
  }>;
  hub: Readonly<{
    getState(): Promise<SidecarState>;
    onStateChange(listener: (state: SidecarState) => void): () => void;
  }>;
  updates: Readonly<{
    check(): Promise<UpdateState>;
    getState(): Promise<UpdateState>;
    openReleasePage(): Promise<void>;
    onStateChange(listener: (state: UpdateState) => void): () => void;
  }>;
}
