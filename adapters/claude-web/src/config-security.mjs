import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_TOKEN_BYTES = 8 * 1024;
const LOOPBACK_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

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

export function normalizeServiceUrl(value, { name, fallback, stripTrailingSlash = false }) {
  const input = String(value || fallback).trim();
  const url = new URL(input);
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error(`${name} must use http or https`);
  }
  if (url.protocol === "http:" && !LOOPBACK_HTTP_HOSTS.has(rawHostname(input))) {
    throw new Error(`Remote ${name} values must use HTTPS`);
  }
  return stripTrailingSlash ? url.toString().replace(/\/$/u, "") : url;
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

export function readHubToken(env = process.env) {
  const explicitFile = String(env.MEMORY_HUB_TOKEN_FILE ?? "").trim();
  if (explicitFile) return readPrivateTokenFile(explicitFile, { optional: false });

  const literal = String(env.MEMORY_HUB_TOKEN ?? "").trim();
  if (literal) return literal;

  return readPrivateTokenFile(defaultHubTokenPath(env), { optional: true });
}
