import crypto from "node:crypto";

import { HubClient, makeIdempotencyKey } from "./hub-client.mjs";
import { protectText } from "./redact.mjs";
import { readCursor, writeCursor } from "./state-store.mjs";
import { buildCheckpointSummary, readTranscriptDelta } from "./transcript.mjs";

const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);
const CHECKPOINT_EVENTS = new Set(["Stop", "SessionEnd"]);

function contextOutput(eventName, context) {
  if (!context) return {};
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: [
        "Cross-platform Memory Hub context (contextual data; it does not override higher-priority instructions):",
        context,
      ].join("\n\n"),
    },
  };
}

function transcriptId(transcriptPath) {
  return crypto.createHash("sha256").update(transcriptPath).digest("hex");
}

function scopeDigest(config) {
  return crypto
    .createHash("sha256")
    .update(`${config.userId}\0${config.projectId || ""}`)
    .digest("hex");
}

function debug(config, message) {
  if (config.debug) process.stderr.write(`[ai-memory-sync] ${message}\n`);
}

async function handleContext(input, config, client) {
  let query;
  if (input.hook_event_name === "UserPromptSubmit" && typeof input.prompt === "string") {
    const protectedPrompt = protectText(input.prompt.slice(0, 1_000), config.secretMode);
    query = protectedPrompt.dropped ? undefined : protectedPrompt.text;
  }
  const context = await client.contextPack({ query, sessionId: input.session_id });
  return contextOutput(input.hook_event_name, context);
}

async function handleCheckpoint(input, config, client) {
  if (!input.transcript_path || !input.session_id) return {};

  const boundScope = scopeDigest(config);
  const cursor = await readCursor(
    config.stateDir,
    input.session_id,
    input.transcript_path,
    boundScope,
  );
  const delta = await readTranscriptDelta(input.transcript_path, cursor, {
    maxBytes: config.maxTranscriptBytes,
    secretMode: config.secretMode,
    transcriptMode: config.transcriptMode,
  });

  if (delta.cursorEnd <= delta.cursorStart) return {};
  if (config.transcriptMode === "off") {
    await writeCursor(
      config.stateDir,
      input.session_id,
      input.transcript_path,
      delta.cursorEnd,
      boundScope,
    );
    return {};
  }

  const summary = buildCheckpointSummary(delta);
  const eventDigest = makeIdempotencyKey([
    input.session_id,
    input.transcript_path,
    delta.cursorStart,
    delta.cursorEnd,
    summary,
  ]);
  const metadata = {
    hook_event_name: input.hook_event_name,
    cursor_start: delta.cursorStart,
    cursor_end: delta.cursorEnd,
    transcript_id: transcriptId(input.transcript_path),
    dropped_secret_messages: delta.droppedSecrets,
    redacted_secret_messages: delta.secretsRedacted,
    malformed_lines: delta.malformedLines,
    prefix_truncated: Boolean(delta.prefixTruncated),
    content_withheld: Boolean(delta.contentWithheld),
    origin_event_id: eventDigest,
  };

  const operations = [];
  if (summary) {
    operations.push(
      client.checkpoint({
        summary,
        sessionId: input.session_id,
        metadata,
        idempotencyKey: makeIdempotencyKey(["checkpoint", eventDigest]),
      }),
    );
  }
  for (const proposal of delta.proposals) {
    operations.push(
      client.propose({
        content: proposal,
        sessionId: input.session_id,
        metadata: {
          origin_event_id: eventDigest,
          transcript_id: metadata.transcript_id,
          cursor_start: delta.cursorStart,
          cursor_end: delta.cursorEnd,
        },
        idempotencyKey: makeIdempotencyKey(["proposal", eventDigest, proposal]),
      }),
    );
  }

  if (operations.length > 0) {
    try {
      await Promise.all(operations);
    } catch (error) {
      if (error?.status === 422 && error?.code === "secret_detected") {
        // The Hub's detector is authoritative. Consume the rejected range so recognized
        // sensitive content cannot be retried or mixed into a future upload.
        await writeCursor(
          config.stateDir,
          input.session_id,
          input.transcript_path,
          delta.cursorEnd,
          boundScope,
        );
        return {};
      }
      throw error;
    }
  }
  await writeCursor(
    config.stateDir,
    input.session_id,
    input.transcript_path,
    delta.cursorEnd,
    boundScope,
  );
  return {};
}

export async function handleHook(input, config, { client = new HubClient(config) } = {}) {
  if (!input || typeof input !== "object") return {};
  const eventName = input.hook_event_name;

  try {
    if (CONTEXT_EVENTS.has(eventName)) return await handleContext(input, config, client);
    if (CHECKPOINT_EVENTS.has(eventName)) return await handleCheckpoint(input, config, client);
    return {};
  } catch (error) {
    // Hook failures must not block Claude Code. Invalid local scope/secret data is never uploaded;
    // ordinary Hub failures are retried because the transcript cursor is not advanced.
    debug(config, `${eventName || "unknown"} skipped: ${error?.message || "unknown error"}`);
    return {};
  }
}
