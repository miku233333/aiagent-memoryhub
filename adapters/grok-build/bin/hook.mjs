#!/usr/bin/env node

import { runHookCli } from "../../codex/src/hook.mjs";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

process.exitCode = await runHookCli(input, {
  environment: { ...process.env, MEMORY_HUB_PLATFORM: "grok_build" },
});
