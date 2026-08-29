import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function stateKey(sessionId, transcriptPath) {
  return crypto.createHash("sha256").update(`${sessionId}\0${transcriptPath}`).digest("hex");
}

function statePath(stateDir, sessionId, transcriptPath) {
  return path.join(stateDir, `${stateKey(sessionId, transcriptPath)}.json`);
}

export async function readCursor(stateDir, sessionId, transcriptPath, scopeDigest) {
  try {
    const raw = await fs.readFile(statePath(stateDir, sessionId, transcriptPath), "utf8");
    const state = JSON.parse(raw);
    if (scopeDigest && state.scope_digest !== scopeDigest) {
      const error = new Error("cursor state belongs to a different Memory Hub scope");
      error.code = "SCOPE_STATE_MISMATCH";
      throw error;
    }
    return Number.isSafeInteger(state.cursor) && state.cursor >= 0 ? state.cursor : 0;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

export async function writeCursor(stateDir, sessionId, transcriptPath, cursor, scopeDigest) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const destination = statePath(stateDir, sessionId, transcriptPath);
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const body = `${JSON.stringify({
    schema_version: "v1",
    cursor,
    ...(scopeDigest ? { scope_digest: scopeDigest } : {}),
    updated_at: new Date().toISOString(),
  })}\n`;
  await fs.writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, destination);
}
