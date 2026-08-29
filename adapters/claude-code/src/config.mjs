import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_TRANSCRIPT_LIMIT = 256 * 1024;
const MAX_TOKEN_BYTES = 8 * 1024;
const LOOPBACK_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parsePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function cleanId(value, name, { optional = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) return undefined;
    throw new Error(`${name} is required`);
  }

  const cleaned = String(value).trim();
  if (!cleaned && !optional) throw new Error(`${name} is required`);
  if (cleaned.length > 128 || /[\u0000-\u001f\u007f]/u.test(cleaned)) {
    throw new Error(`${name} is invalid`);
  }
  return cleaned || undefined;
}

function rawHostname(value) {
  const text = String(value).trim();
  const marker = text.indexOf("://");
  if (marker < 0) return "";
  const authority = text.slice(marker + 3).split(/[/?#]/u, 1)[0];
  if (!authority || authority.includes("@")) return "";
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return end < 0 ? "" : authority.slice(0, end + 1).toLowerCase();
  }
  const colon = authority.lastIndexOf(":");
  return (colon < 0 ? authority : authority.slice(0, colon)).toLowerCase();
}

function normalizeBaseUrl(value) {
  const input = String(value || "http://127.0.0.1:8787").trim();
  const url = new URL(input);
  if (url.username || url.password) throw new Error("MEMORY_HUB_URL must not contain credentials");
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("MEMORY_HUB_URL must use http or https");
  }
  if (url.protocol === "http:" && !LOOPBACK_HTTP_HOSTS.has(rawHostname(input))) {
    throw new Error("Remote MEMORY_HUB_URL values must use HTTPS");
  }
  return url.toString().replace(/\/$/u, "");
}

export function defaultHubTokenPath(env = process.env, platform = process.platform) {
  if (platform === "win32") {
    const base = env.APPDATA || path.join(env.USERPROFILE || os.homedir(), "AppData", "Roaming");
    return path.join(base, "MemoryHub", "hub-token");
  }
  const home = env.HOME || os.homedir();
  const base =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : env.XDG_CONFIG_HOME || path.join(home, ".config");
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

function readHubToken(env) {
  const explicitFile = String(env.MEMORY_HUB_TOKEN_FILE ?? "").trim();
  if (explicitFile) return readPrivateTokenFile(explicitFile, { optional: false });
  const literal = String(env.MEMORY_HUB_TOKEN ?? "").trim();
  if (literal) return literal;
  return readPrivateTokenFile(defaultHubTokenPath(env), { optional: true });
}

export function loadConfig(env = process.env, overrides = {}) {
  const transcriptMode = env.MEMORY_HUB_TRANSCRIPT_MODE || "redacted";
  if (!new Set(["redacted", "metadata-only", "off"]).has(transcriptMode)) {
    throw new Error("MEMORY_HUB_TRANSCRIPT_MODE must be redacted, metadata-only, or off");
  }

  const secretMode = env.MEMORY_HUB_SECRET_MODE || "strict";
  if (!new Set(["strict", "redact"]).has(secretMode)) {
    throw new Error("MEMORY_HUB_SECRET_MODE must be strict or redact");
  }

  const userId = cleanId(env.MEMORY_HUB_USER_ID, "MEMORY_HUB_USER_ID");
  const projectId = cleanId(env.MEMORY_HUB_PROJECT_ID, "MEMORY_HUB_PROJECT_ID", {
    optional: true,
  });

  return {
    hubUrl: normalizeBaseUrl(env.MEMORY_HUB_URL),
    token: readHubToken(env),
    userId,
    projectId,
    target: "claude_code",
    sourcePlatform: "claude_code",
    timeoutMs: parsePositiveInteger(env.MEMORY_HUB_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, {
      min: 100,
      max: 10_000,
    }),
    maxTranscriptBytes: parsePositiveInteger(
      env.MEMORY_HUB_MAX_TRANSCRIPT_BYTES,
      DEFAULT_TRANSCRIPT_LIMIT,
      { min: 4_096, max: 4 * 1024 * 1024 },
    ),
    maxContextItems: parsePositiveInteger(env.MEMORY_HUB_CONTEXT_LIMIT, 20, {
      min: 1,
      max: 100,
    }),
    transcriptMode,
    secretMode,
    debug: env.MEMORY_HUB_DEBUG === "1",
    stateDir:
      overrides.stateDir ||
      env.MEMORY_HUB_STATE_DIR ||
      env.CLAUDE_PLUGIN_DATA ||
      path.join(os.homedir(), ".claude", "ai-memory-sync"),
  };
}

export function scopeFromConfig(config) {
  return {
    user_id: config.userId,
    ...(config.projectId ? { project_id: config.projectId } : {}),
  };
}
