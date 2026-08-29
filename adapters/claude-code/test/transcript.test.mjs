import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCheckpointSummary, readTranscriptDelta } from "../src/transcript.mjs";

function line(role, content) {
  return `${JSON.stringify({ type: role, message: { role, content } })}\n`;
}

test("reads only complete JSONL records and advances a byte cursor", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-sync-transcript-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, "session.jsonl");
  const first = line("user", [{ type: "text", text: "记住：项目使用 PostgreSQL" }]);
  const secret = line("user", "api_key=super-secret-value");
  const partial = JSON.stringify({ type: "assistant", message: { role: "assistant", content: "later" } });
  await fs.writeFile(transcriptPath, `${first}${secret}${partial}`, "utf8");

  const delta = await readTranscriptDelta(transcriptPath, 0, {
    secretMode: "strict",
    transcriptMode: "redacted",
  });
  assert.equal(delta.cursorEnd, Buffer.byteLength(`${first}${secret}`));
  assert.equal(delta.droppedSecrets, 1);
  assert.deepEqual(delta.proposals, ["项目使用 PostgreSQL"]);
  assert.equal(buildCheckpointSummary(delta), "user: 记住：项目使用 PostgreSQL");

  await fs.appendFile(transcriptPath, "\n", "utf8");
  const next = await readTranscriptDelta(transcriptPath, delta.cursorEnd, {
    secretMode: "strict",
    transcriptMode: "redacted",
  });
  assert.deepEqual(next.messages, [{ role: "assistant", text: "later" }]);
});

test("metadata-only and off modes do not expose transcript text", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-sync-private-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, "session.jsonl");
  await fs.writeFile(transcriptPath, line("user", "private words"), "utf8");

  const metadataOnly = await readTranscriptDelta(transcriptPath, 0, {
    transcriptMode: "metadata-only",
  });
  assert.deepEqual(metadataOnly.messages, []);
  assert.equal(metadataOnly.contentWithheld, true);
  assert.doesNotMatch(buildCheckpointSummary(metadataOnly), /private words/u);

  const off = await readTranscriptDelta(transcriptPath, 0, { transcriptMode: "off" });
  assert.deepEqual(off.messages, []);
  assert.equal(off.cursorEnd, Buffer.byteLength(line("user", "private words")));
});

test("checkpoint summaries stay below the Hub schema limit", () => {
  const summary = buildCheckpointSummary({
    contentWithheld: false,
    messages: Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      text: "x".repeat(4_000),
    })),
  });
  assert.ok(summary.length <= 48_000);
  assert.match(summary, /checkpoint content truncated locally/u);
});
