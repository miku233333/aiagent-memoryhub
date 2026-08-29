"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const execFileAsync = promisify(execFile);

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  // Cloud-backed workspaces can attach Finder metadata that makes any later
  // signature invalid. Remove it from the generated bundle before signing.
  await execFileAsync("/usr/bin/xattr", ["-cr", appPath]);

};
