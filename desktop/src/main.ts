import path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
} from "electron";
import { autoUpdater } from "electron-updater";

import { APP_ID, APP_NAME, HUB_ORIGIN } from "./constants";
import { IPC_CHANNELS, type AppInfo } from "./contracts";
import { runEnvironmentCheck } from "./environmentDoctor";
import { withHubAuthorization } from "./hubAuth";
import { assertTrustedIpcRequest } from "./ipcPolicy";
import { classifyNavigation } from "./navigationPolicy";
import {
  HubProcessController,
  loadOrCreateHubToken,
  resolveSidecarLaunchPlan,
  type SidecarState,
} from "./sidecar";
import {
  UpdateService,
  type DownloadPromptDecision,
  type ReleaseSummary,
  type UpdateState,
} from "./updateService";

app.enableSandbox();
app.setName(APP_NAME);

let hubController: HubProcessController | undefined;
let hubLoaded = false;
let isQuitting = false;
let mainWindow: BrowserWindow | undefined;
let recoveryInProgress = false;
let updateService: UpdateService | undefined;

function createMainWindow(): BrowserWindow {
  const windowIcon = app.isPackaged
    ? path.join(process.resourcesPath, "Icons", "icon.png")
    : path.join(app.getAppPath(), "resources", "icons", "icon.png");
  const window = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: "#f4f7fb",
    height: 820,
    minHeight: 640,
    minWidth: 920,
    icon: windowIcon,
    show: false,
    title: APP_NAME,
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
    width: 1240,
  });

  installNavigationPolicy(window);
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
  return window;
}

function installNavigationPolicy(window: BrowserWindow): void {
  const handleNavigation = (
    event: Electron.Event,
    targetURL: string,
  ): void => {
    const decision = classifyNavigation(targetURL);
    if (decision === "allow-local") {
      return;
    }

    event.preventDefault();
    if (decision === "open-release-external") {
      void openApprovedExternal(targetURL);
    }
  };

  window.webContents.on("will-navigate", handleNavigation);
  window.webContents.on("will-redirect", handleNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = classifyNavigation(url);
    if (decision === "allow-local") {
      void window.webContents.loadURL(url);
    } else if (decision === "open-release-external") {
      void openApprovedExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("did-create-window", (createdWindow) => {
    createdWindow.destroy();
  });
}

async function openApprovedExternal(targetURL: string): Promise<void> {
  if (classifyNavigation(targetURL) !== "open-release-external") {
    throw new Error("External URL denied by navigation policy");
  }
  await shell.openExternal(targetURL);
}

function configureSessionSecurity(hubToken: string): void {
  const applicationSession = session.defaultSession;
  applicationSession.setPermissionCheckHandler(() => false);
  applicationSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  applicationSession.setDevicePermissionHandler(() => false);
  applicationSession.webRequest.onBeforeSendHeaders(
    { urls: [`${HUB_ORIGIN}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: withHubAuthorization(
          details.url,
          details.requestHeaders,
          hubToken,
        ),
      });
    },
  );

  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
  ].join("; ");
  applicationSession.webRequest.onHeadersReceived(
    { urls: [`${HUB_ORIGIN}/*`] },
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [contentSecurityPolicy],
        },
      });
    },
  );
}

function registerNoArgumentHandler(
  channel: string,
  handler: () => unknown | Promise<unknown>,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    const senderFrame = event.senderFrame;
    assertTrustedIpcRequest({
      argumentCount: args.length,
      frameURL: senderFrame?.url ?? null,
      isTopLevelFrame:
        senderFrame !== null && senderFrame === event.sender.mainFrame,
    });
    return handler();
  });
}

function publicSidecarState(): SidecarState {
  const state = hubController?.state ?? { phase: "idle" as const };
  return state.phase === "failed"
    ? { phase: "failed", message: "Hub service unavailable" }
    : state;
}

function registerIPCHandlers(): void {
  registerNoArgumentHandler(IPC_CHANNELS.appInfoGet, (): AppInfo => ({
    name: APP_NAME,
    platform: process.platform,
    version: app.getVersion(),
  }));
  registerNoArgumentHandler(IPC_CHANNELS.environmentRunCheck, () =>
    runEnvironmentCheck(hubController?.state ?? { phase: "idle" }),
  );
  registerNoArgumentHandler(IPC_CHANNELS.hubStateGet, () =>
    publicSidecarState(),
  );
  registerNoArgumentHandler(IPC_CHANNELS.updateStateGet, () =>
    updateService?.state ?? ({ phase: "idle" } satisfies UpdateState),
  );
  registerNoArgumentHandler(IPC_CHANNELS.updateCheck, async () => {
    if (updateService === undefined) {
      return { phase: "idle" } satisfies UpdateState;
    }
    await updateService.checkNow();
    return updateService.state;
  });
  registerNoArgumentHandler(IPC_CHANNELS.updateOpenRelease, async () => {
    if (updateService === undefined) {
      throw new Error("Update service is not ready");
    }
    await updateService.openReleasePage();
  });
}

function broadcastState(channel: string, state: unknown): void {
  const window = mainWindow;
  if (
    window === undefined ||
    window.isDestroyed() ||
    classifyNavigation(window.webContents.getURL()) !== "allow-local"
  ) {
    return;
  }
  window.webContents.send(channel, state);
}

async function showMessageBox(
  options: MessageBoxOptions,
): Promise<MessageBoxReturnValue> {
  const window = mainWindow;
  return window !== undefined && !window.isDestroyed()
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options);
}

function safeVersionLabel(release: ReleaseSummary): string {
  const bounded = release.version.replace(/[^0-9A-Za-z.+-]/g, "").slice(0, 48);
  return bounded === "" ? "新版" : bounded;
}

async function promptForDownload(
  release: ReleaseSummary,
): Promise<DownloadPromptDecision> {
  if (isQuitting) {
    return "later";
  }
  const response = await showMessageBox({
    buttons: ["稍后", "查看发布页", "下载更新"],
    cancelId: 0,
    defaultId: 0,
    detail: "应用不会自动下载。只有你选择“下载更新”后才会开始。",
    message: `发现 AI Agent MemoryHub ${safeVersionLabel(release)}`,
    noLink: true,
    title: `${APP_NAME} 更新`,
    type: "info",
  });
  if (response.response === 1) {
    return "view-release";
  }
  return response.response === 2 ? "download" : "later";
}

async function promptForInstall(release: ReleaseSummary): Promise<boolean> {
  if (isQuitting) {
    return false;
  }
  const response = await showMessageBox({
    buttons: ["稍后", "重新启动并安装"],
    cancelId: 0,
    defaultId: 0,
    detail: "安装只会在你确认后执行，并会重新启动应用。",
    message: `${safeVersionLabel(release)} 已下载完成`,
    noLink: true,
    title: `${APP_NAME} 更新`,
    type: "info",
  });
  return response.response === 1;
}

function createUpdateService(): UpdateService {
  const service = new UpdateService({
    openExternal: openApprovedExternal,
    promptForDownload,
    promptForInstall,
    updater: autoUpdater,
  });
  service.on("state", (state: UpdateState) => {
    broadcastState(IPC_CHANNELS.updateStateChanged, state);
  });
  return service;
}

async function showHubStartupFailure(message: string): Promise<"retry" | "quit"> {
  const response = await showMessageBox({
    buttons: ["退出", "重试"],
    cancelId: 0,
    defaultId: 1,
    detail: message,
    message: "本地 MemoryHub 服务未能启动",
    noLink: true,
    title: APP_NAME,
    type: "error",
  });
  return response.response === 1 ? "retry" : "quit";
}

async function startHubAndShow(): Promise<void> {
  const controller = hubController;
  const window = mainWindow;
  if (controller === undefined || window === undefined) {
    throw new Error("Desktop runtime was not initialized");
  }

  while (!isQuitting) {
    try {
      await controller.start();
      await window.loadURL(HUB_ORIGIN);
      hubLoaded = true;
      if (!window.isDestroyed()) {
        window.show();
      }
      return;
    } catch (error) {
      hubLoaded = false;
      const message = error instanceof Error ? error.message : String(error);
      const decision = await showHubStartupFailure(message);
      if (decision === "quit") {
        app.quit();
        return;
      }
    }
  }
}

async function recoverFromRuntimeFailure(): Promise<void> {
  if (recoveryInProgress || isQuitting) {
    return;
  }
  recoveryInProgress = true;
  hubLoaded = false;
  mainWindow?.hide();
  try {
    await startHubAndShow();
  } finally {
    recoveryInProgress = false;
  }
}

async function startApplication(): Promise<void> {
  if (process.platform === "win32") {
    app.setAppUserModelId(APP_ID);
  }

  const launchPlan = resolveSidecarLaunchPlan({
    appDataPath: app.getPath("appData"),
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
  });
  const hubToken = loadOrCreateHubToken(launchPlan.tokenPath);
  configureSessionSecurity(hubToken);
  mainWindow = createMainWindow();
  hubController = new HubProcessController({
    hubToken,
    launchPlan,
  });
  hubController.on("state", (state: SidecarState) => {
    broadcastState(IPC_CHANNELS.hubStateChanged, publicSidecarState());
    if (state.phase === "failed" && hubLoaded) {
      void recoverFromRuntimeFailure();
    }
  });

  updateService = createUpdateService();
  registerIPCHandlers();
  await startHubAndShow();
  if (!isQuitting) {
    updateService.start();
  }
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});
app.on("before-quit", () => {
  isQuitting = true;
  hubController?.stopImmediately();
});
app.on("window-all-closed", () => app.quit());
app.on("second-instance", () => {
  const window = mainWindow;
  if (window !== undefined && !window.isDestroyed()) {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(startApplication).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    await dialog.showMessageBox({
      detail: message,
      message: `${APP_NAME} 无法启动`,
      title: APP_NAME,
      type: "error",
    });
    app.quit();
  });
}
