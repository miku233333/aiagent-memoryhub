/// <reference types="vite/client" />

type MemoryHubDesktopTool = "node" | "python3" | "uv" | "git" | "claude";

interface MemoryHubDesktopToolCheck {
  installed: boolean;
  status: "available" | "missing" | "timeout" | "error";
  tool: MemoryHubDesktopTool;
  version?: string;
}

interface MemoryHubDesktopEnvironmentCheckResult {
  checkedAt: string;
  hub: {
    service: "memory-hub";
    status: "idle" | "starting" | "waiting-health" | "ready" | "failed" | "stopped";
  };
  tools: MemoryHubDesktopToolCheck[];
}

interface MemoryHubDesktopEnvironmentBridge {
  runCheck(): Promise<MemoryHubDesktopEnvironmentCheckResult>;
}

interface MemoryHubDesktopBridge {
  environment?: MemoryHubDesktopEnvironmentBridge;
}

interface Window {
  memoryHubDesktop?: MemoryHubDesktopBridge;
}
