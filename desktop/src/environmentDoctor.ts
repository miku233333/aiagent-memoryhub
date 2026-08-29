import { execFile } from "node:child_process";

import type {
  EnvironmentCheckResult,
  ToolCheckResult,
  ToolIdentifier,
} from "./contracts";
import type { SidecarState } from "./sidecar";

export type FixedCommandOutcome =
  | { outcome: "completed"; stdout: string; stderr: string }
  | { outcome: "missing" | "timeout" | "error" };

export type FixedCommandExecutor = (
  command: string,
  args: readonly string[],
) => Promise<FixedCommandOutcome>;

const FIXED_TOOL_CHECKS: ReadonlyArray<{
  tool: ToolIdentifier;
  command: string;
  args: readonly ["--version"];
}> = [
  { tool: "node", command: "node", args: ["--version"] },
  { tool: "python3", command: "python3", args: ["--version"] },
  { tool: "uv", command: "uv", args: ["--version"] },
  { tool: "git", command: "git", args: ["--version"] },
  { tool: "claude", command: "claude", args: ["--version"] },
];

function minimalCommandEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  const permittedKeys = [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "LANG",
    "LC_ALL",
  ];

  for (const permittedKey of permittedKeys) {
    const matchingKey = Object.keys(process.env).find(
      (key) => key.toUpperCase() === permittedKey,
    );
    if (matchingKey !== undefined) {
      environment[matchingKey] = process.env[matchingKey];
    }
  }
  return environment;
}

export function executeFixedVersionCommand(
  command: string,
  args: readonly string[],
): Promise<FixedCommandOutcome> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        env: minimalCommandEnvironment(),
        maxBuffer: 16 * 1024,
        shell: false,
        timeout: 3_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ outcome: "completed", stdout, stderr });
          return;
        }

        const processError = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: string | null;
        };
        if (processError.code === "ENOENT") {
          resolve({ outcome: "missing" });
        } else if (processError.killed === true || processError.signal === "SIGTERM") {
          resolve({ outcome: "timeout" });
        } else {
          resolve({ outcome: "error" });
        }
      },
    );
  });
}

function extractVersion(stdout: string, stderr: string): string | undefined {
  const boundedOutput = `${stdout}\n${stderr}`.slice(0, 16 * 1024);
  const match = boundedOutput.match(
    /(?:^|[^0-9A-Za-z])v?(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)/,
  );
  return match?.[1]?.slice(0, 64);
}

async function checkTool(
  tool: ToolIdentifier,
  command: string,
  args: readonly string[],
  execute: FixedCommandExecutor,
): Promise<ToolCheckResult> {
  const outcome = await execute(command, args);
  if (outcome.outcome !== "completed") {
    return {
      installed: false,
      status: outcome.outcome,
      tool,
    };
  }

  const version = extractVersion(outcome.stdout, outcome.stderr);
  return version === undefined
    ? { installed: true, status: "available", tool }
    : { installed: true, status: "available", tool, version };
}

export interface EnvironmentCheckOptions {
  execute?: FixedCommandExecutor;
  now?: () => Date;
}

export async function runEnvironmentCheck(
  sidecarState: SidecarState,
  options: EnvironmentCheckOptions = {},
): Promise<EnvironmentCheckResult> {
  const execute = options.execute ?? executeFixedVersionCommand;
  const now = options.now ?? (() => new Date());
  const tools = await Promise.all(
    FIXED_TOOL_CHECKS.map(({ args, command, tool }) =>
      checkTool(tool, command, args, execute),
    ),
  );

  return {
    checkedAt: now().toISOString(),
    hub: {
      service: "memory-hub",
      status: sidecarState.phase,
    },
    tools,
  };
}
