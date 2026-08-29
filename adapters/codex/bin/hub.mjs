#!/usr/bin/env node

import { runCli } from "../src/cli.mjs";

let stdinText = "";
if (!process.stdin.isTTY) {
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) stdinText += chunk;
}

process.exitCode = await runCli(process.argv.slice(2), { stdinText });
