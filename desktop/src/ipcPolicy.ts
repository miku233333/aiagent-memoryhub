import { classifyNavigation } from "./navigationPolicy";

export interface IpcRequestContext {
  argumentCount: number;
  frameURL: string | null;
  isTopLevelFrame: boolean;
}

export function assertTrustedIpcRequest(context: IpcRequestContext): void {
  if (
    !context.isTopLevelFrame ||
    context.frameURL === null ||
    classifyNavigation(context.frameURL) !== "allow-local"
  ) {
    throw new Error("IPC request denied for an untrusted renderer");
  }
  if (context.argumentCount !== 0) {
    throw new Error("IPC method does not accept arguments");
  }
}
