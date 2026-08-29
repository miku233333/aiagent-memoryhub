import { describe, expect, it, vi } from "vitest";

import { runEnvironmentCheck } from "../src/environmentDoctor";

describe("runEnvironmentCheck", () => {
  it("runs only the fixed version allowlist and returns sanitized results", async () => {
    const execute = vi.fn(async (command: string, args: readonly string[]) => {
      const output: Record<string, string> = {
        node: "v24.1.0\n",
        python3: "Python 3.13.2\n",
        uv: "uv 0.7.1 (/private/secret/path)\n",
        git: "git version 2.49.0 (Apple Git-154)\n",
        claude: "2.1.3 (Claude Code)\n",
      };
      return {
        outcome: "completed" as const,
        stderr: "",
        stdout: output[command] ?? "",
      };
    });

    const result = await runEnvironmentCheck(
      { phase: "ready", pid: 123 },
      {
        execute,
        now: () => new Date("2026-08-30T00:00:00.000Z"),
      },
    );

    expect(execute.mock.calls).toEqual([
      ["node", ["--version"]],
      ["python3", ["--version"]],
      ["uv", ["--version"]],
      ["git", ["--version"]],
      ["claude", ["--version"]],
    ]);
    expect(result).toEqual({
      checkedAt: "2026-08-30T00:00:00.000Z",
      hub: { service: "memory-hub", status: "ready" },
      tools: [
        { installed: true, status: "available", tool: "node", version: "24.1.0" },
        {
          installed: true,
          status: "available",
          tool: "python3",
          version: "3.13.2",
        },
        { installed: true, status: "available", tool: "uv", version: "0.7.1" },
        { installed: true, status: "available", tool: "git", version: "2.49.0" },
        {
          installed: true,
          status: "available",
          tool: "claude",
          version: "2.1.3",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("/private/secret/path");
    expect(JSON.stringify(result)).not.toContain("Apple Git");
  });

  it("reports bounded statuses without returning process errors", async () => {
    const execute = vi.fn(async (command: string) => {
      if (command === "python3") {
        return { outcome: "timeout" as const };
      }
      if (command === "claude") {
        return { outcome: "missing" as const };
      }
      return { outcome: "error" as const };
    });

    const result = await runEnvironmentCheck(
      { phase: "failed", message: "/secret/database/path" },
      { execute },
    );

    expect(result.tools.find((item) => item.tool === "python3")).toEqual({
      installed: false,
      status: "timeout",
      tool: "python3",
    });
    expect(result.tools.find((item) => item.tool === "claude")).toEqual({
      installed: false,
      status: "missing",
      tool: "claude",
    });
    expect(JSON.stringify(result)).not.toContain("/secret/database/path");
  });
});
