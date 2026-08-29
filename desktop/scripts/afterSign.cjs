"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const execFileAsync = promisify(execFile);

module.exports = async function afterSign(context) {
  if (
    context.electronPlatformName !== "darwin" ||
    process.env.MEMORY_HUB_ADHOC_SIGN !== "1"
  ) {
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  await execFileAsync("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    appPath,
  ]);
};
