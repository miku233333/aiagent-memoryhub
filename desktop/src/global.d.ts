import type { MemoryHubDesktopAPI } from "./contracts";

declare global {
  interface Window {
    memoryHubDesktop: MemoryHubDesktopAPI;
  }
}

export {};
