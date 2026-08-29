import { contextBridge, ipcRenderer } from "electron";

import type {
  EnvironmentCheckResult,
  MemoryHubDesktopAPI,
} from "./contracts";
import type { SidecarState } from "./sidecar";
import type { UpdateState } from "./updateService";

// Keep these literals in this standalone preload. A sandboxed preload may only
// require Electron and a small set of built-in modules, so runtime imports from
// other local files are deliberately avoided.
const channels = Object.freeze({
  appInfoGet: "memory-hub:app-info:get",
  environmentRunCheck: "memory-hub:environment:run-check",
  hubStateChanged: "memory-hub:hub:state-changed",
  hubStateGet: "memory-hub:hub:state:get",
  updateCheck: "memory-hub:update:check",
  updateOpenRelease: "memory-hub:update:open-release",
  updateStateChanged: "memory-hub:update:state-changed",
  updateStateGet: "memory-hub:update:state:get",
});

function subscribe<State>(
  channel: string,
  listener: (state: State) => void,
): () => void {
  if (typeof listener !== "function") {
    throw new TypeError("State listener must be a function");
  }
  const handler = (_event: Electron.IpcRendererEvent, state: State): void => {
    listener(state);
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: MemoryHubDesktopAPI = Object.freeze({
  appInfo: Object.freeze({
    get: () => ipcRenderer.invoke(channels.appInfoGet),
  }),
  environment: Object.freeze({
    runCheck: (): Promise<EnvironmentCheckResult> =>
      ipcRenderer.invoke(channels.environmentRunCheck),
  }),
  hub: Object.freeze({
    getState: (): Promise<SidecarState> =>
      ipcRenderer.invoke(channels.hubStateGet),
    onStateChange: (listener: (state: SidecarState) => void) =>
      subscribe(channels.hubStateChanged, listener),
  }),
  updates: Object.freeze({
    check: (): Promise<UpdateState> =>
      ipcRenderer.invoke(channels.updateCheck),
    getState: (): Promise<UpdateState> =>
      ipcRenderer.invoke(channels.updateStateGet),
    onStateChange: (listener: (state: UpdateState) => void) =>
      subscribe(channels.updateStateChanged, listener),
    openReleasePage: (): Promise<void> =>
      ipcRenderer.invoke(channels.updateOpenRelease),
  }),
});

contextBridge.exposeInMainWorld("memoryHubDesktop", api);
