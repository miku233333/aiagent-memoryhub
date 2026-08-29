#!/usr/bin/env node

import process from "node:process";

import { loadConfig } from "../src/config.mjs";
import { handleHook } from "../src/hook-handler.mjs";

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--state-dir") {
      result.stateDir = argv[index + 1];
      index += 1;
    }
  }
  return result;
}

async function readStandardInput() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function main() {
  let output = {};
  try {
    const input = await readStandardInput();
    const config = loadConfig(process.env, parseArguments(process.argv.slice(2)));
    output = await handleHook(input, config);
  } catch (error) {
    if (process.env.MEMORY_HUB_DEBUG === "1") {
      process.stderr.write(`[ai-memory-sync] hook skipped: ${error?.message || "unknown error"}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

await main();
