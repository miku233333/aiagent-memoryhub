import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SUPPORTED_PLATFORMS = new Set([
  "codex",
  "qoder",
  "openclaw",
  "hermes",
  "grok_build",
  "gemini_web",
  "grok_web",
]);
const MAX_TOKEN_BYTES = 8 * 1024;

function required(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export function defaultHubTokenPath(environment = process.env, platform = process.platform) {
  if (platform === "win32") {
    const base =
      environment.APPDATA ||
      path.join(environment.USERPROFILE || os.homedir(), "AppData", "Roaming");
    return path.join(base, "MemoryHub", "hub-token");
  }
  const home = environment.HOME || os.homedir();
  const base =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : environment.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "MemoryHub", "hub-token");
}

function readPrivateTokenFile(filePath, { optional }) {
  let descriptor;
  try {
    const pathMetadata = fs.lstatSync(filePath);
    if (!pathMetadata.isFile()) throw new Error("token path is not a regular file");
    const flags =
      process.platform === "win32"
        ? fs.constants.O_RDONLY
        : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    descriptor = fs.openSync(filePath, flags);
    const metadata = fs.fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino ||
      metadata.size < 1 ||
      metadata.size > MAX_TOKEN_BYTES
    ) {
      throw new Error("not a bounded regular file");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("token file is accessible by group or others");
    }
    const token = fs.readFileSync(descriptor, "utf8").trim();
    if (!token || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES || /[\u0000-\u001f\u007f]/u.test(token)) {
      throw new Error("token content is invalid");
    }
    return token;
  } catch (error) {
    if (optional) return undefined;
    throw new Error("MEMORY_HUB_TOKEN_FILE could not be read securely", { cause: error });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readHubToken(environment) {
  const explicitFile = String(environment.MEMORY_HUB_TOKEN_FILE ?? "").trim();
  if (explicitFile) return readPrivateTokenFile(explicitFile, { optional: false });
  const literal = String(environment.MEMORY_HUB_TOKEN ?? "").trim();
  if (literal) return literal;
  return readPrivateTokenFile(defaultHubTokenPath(environment), { optional: true });
}

export function loadConfig(environment = process.env) {
  const userId = required(environment.MEMORY_HUB_USER_ID, "MEMORY_HUB_USER_ID");
  const projectId = String(environment.MEMORY_HUB_PROJECT_ID ?? "").trim() || undefined;
  const platform = required(environment.MEMORY_HUB_PLATFORM, "MEMORY_HUB_PLATFORM");
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`MEMORY_HUB_PLATFORM must be one of: ${[...SUPPORTED_PLATFORMS].join(", ")}`);
  }

  const url = new URL(environment.MEMORY_HUB_URL || "http://127.0.0.1:8787");
  if (url.username || url.password) throw new Error("MEMORY_HUB_URL must not contain credentials");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("Remote Memory Hub URLs must use HTTPS");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");

  return Object.freeze({
    url: url.toString().replace(/\/$/, ""),
    token: readHubToken(environment),
    platform,
    scope: Object.freeze({
      user_id: userId,
      ...(projectId ? { project_id: projectId } : {}),
    }),
    timeoutMs: positiveInteger(environment.MEMORY_HUB_TIMEOUT_MS, 3_000, "MEMORY_HUB_TIMEOUT_MS"),
    maxItems: positiveInteger(environment.MEMORY_HUB_MAX_ITEMS, 20, "MEMORY_HUB_MAX_ITEMS"),
    writeEnabled: /^(1|true|yes)$/i.test(String(environment.MEMORY_HUB_WRITE_ENABLED ?? "")),
  });
}

export { SUPPORTED_PLATFORMS };
