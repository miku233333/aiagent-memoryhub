import fs from "node:fs/promises";

import { protectText } from "./redact.mjs";

const MAX_MESSAGE_CHARS = 4_000;
const MAX_MESSAGES_PER_DELTA = 80;
const MAX_CHECKPOINT_CHARS = 48_000;

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (block) =>
        block &&
        typeof block === "object" &&
        (block.type === "text" || block.type === "input_text" || block.type === "output_text"),
    )
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function messageFromRecord(record) {
  if (!record || typeof record !== "object") return undefined;
  if (record.type !== "user" && record.type !== "assistant") return undefined;

  const message = record.message && typeof record.message === "object" ? record.message : record;
  const role = message.role || record.type;
  if (role !== "user" && role !== "assistant") return undefined;

  const text = textFromContent(message.content).slice(0, MAX_MESSAGE_CHARS).trim();
  return text ? { role, text } : undefined;
}

function consumeCompleteLines(buffer, effectiveStart, wasPrefixTruncated) {
  let startInBuffer = 0;
  if (wasPrefixTruncated) {
    const firstNewline = buffer.indexOf(0x0a);
    if (firstNewline === -1) {
      return {
        bytes: Buffer.alloc(0),
        cursor: effectiveStart + buffer.length,
        skippedOversizeRecord: true,
      };
    }
    startInBuffer = firstNewline + 1;
  }

  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < startInBuffer) {
    return { bytes: Buffer.alloc(0), cursor: effectiveStart + startInBuffer };
  }

  return {
    bytes: buffer.subarray(startInBuffer, lastNewline + 1),
    cursor: effectiveStart + lastNewline + 1,
    skippedOversizeRecord: false,
  };
}

export async function readTranscriptDelta(
  transcriptPath,
  cursor = 0,
  { maxBytes = 256 * 1024, secretMode = "strict", transcriptMode = "redacted" } = {},
) {
  const handle = await fs.open(transcriptPath, "r");
  try {
    const stat = await handle.stat();
    const requestedCursor = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
    const reset = requestedCursor > stat.size;
    const safeCursor = reset ? 0 : requestedCursor;
    const unreadBytes = stat.size - safeCursor;
    const wasPrefixTruncated = unreadBytes > maxBytes;
    const effectiveStart = wasPrefixTruncated ? stat.size - maxBytes : safeCursor;
    const size = stat.size - effectiveStart;
    const allocated = Buffer.alloc(size);
    let bytesRead = 0;
    while (bytesRead < size) {
      const result = await handle.read(
        allocated,
        bytesRead,
        size - bytesRead,
        effectiveStart + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const buffer = allocated.subarray(0, bytesRead);

    if (transcriptMode === "off") {
      return {
        cursorStart: safeCursor,
        cursorEnd: stat.size,
        messages: [],
        proposals: [],
        droppedSecrets: 0,
        malformedLines: 0,
        transcriptBytes: stat.size,
        reset,
        contentWithheld: true,
      };
    }

    const consumed = consumeCompleteLines(buffer, effectiveStart, wasPrefixTruncated);
    const lines = consumed.bytes.toString("utf8").split("\n").filter(Boolean);
    const messages = [];
    const proposals = [];
    const seenProposals = new Set();
    let malformedLines = 0;
    let droppedSecrets = 0;
    let secretsRedacted = 0;

    if (transcriptMode !== "metadata-only") {
      for (const line of lines) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          malformedLines += 1;
          continue;
        }

        const message = messageFromRecord(record);
        if (!message) continue;
        const protectedText = protectText(message.text, secretMode);
        if (protectedText.dropped) {
          droppedSecrets += 1;
          continue;
        }
        if (protectedText.secretDetected) secretsRedacted += 1;
        if (protectedText.text) {
          const safeMessage = { role: message.role, text: protectedText.text };
          for (const proposal of extractExplicitMemoryProposals([safeMessage])) {
            if (!seenProposals.has(proposal) && proposals.length < 5) {
              seenProposals.add(proposal);
              proposals.push(proposal);
            }
          }
          messages.push(safeMessage);
          if (messages.length > MAX_MESSAGES_PER_DELTA) messages.shift();
        }
      }
    }

    return {
      cursorStart: safeCursor,
      cursorEnd: consumed.cursor,
      messages,
      proposals,
      droppedSecrets,
      secretsRedacted,
      malformedLines,
      transcriptBytes: stat.size,
      reset,
      prefixTruncated: wasPrefixTruncated,
      skippedOversizeRecord: Boolean(consumed.skippedOversizeRecord),
      contentWithheld: transcriptMode === "metadata-only",
    };
  } finally {
    await handle.close();
  }
}

export function extractExplicitMemoryProposals(messages) {
  const patterns = [
    /^(?:请)?(?:记住|記住|记下|記下)\s*[:：,，]?\s*(.+)$/isu,
    /^(?:以后|以後)(?:都)?(?:请|請)?\s*(.+)$/isu,
    /^(?:remember(?: that)?|please remember(?: that)?|from now on|my preference is)\s*[:,-]?\s*(.+)$/isu,
  ];

  const seen = new Set();
  const proposals = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const pattern of patterns) {
      const match = pattern.exec(message.text.trim());
      const content = match?.[1]?.trim();
      if (!content || seen.has(content)) continue;
      seen.add(content);
      proposals.push(content);
      break;
    }
  }
  return proposals.slice(0, 5);
}

export function buildCheckpointSummary(delta) {
  if (delta.contentWithheld) {
    return `Transcript content withheld by metadata-only mode; processed bytes ${delta.cursorStart}-${delta.cursorEnd}.`;
  }
  const summary = delta.messages.map((message) => `${message.role}: ${message.text}`).join("\n\n");
  if (summary.length <= MAX_CHECKPOINT_CHARS) return summary;

  const marker = "\n\n[checkpoint content truncated locally]\n\n";
  const side = Math.floor((MAX_CHECKPOINT_CHARS - marker.length) / 2);
  return `${summary.slice(0, side)}${marker}${summary.slice(-side)}`;
}
