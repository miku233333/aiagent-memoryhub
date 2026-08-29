import crypto from "node:crypto";

import { scopeFromConfig } from "./config.mjs";

export function makeIdempotencyKey(parts) {
  return crypto
    .createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\0"))
    .digest("hex");
}

export class HubClient {
  constructor(config, fetchImplementation = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImplementation;
  }

  async post(path, body, { idempotencyKey } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetch(`${this.config.hubUrl}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          "x-memory-sync-target": this.config.target,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`Memory Hub request failed with HTTP ${response.status}`);
        error.status = response.status;
        if ((response.headers.get("content-type") || "").includes("application/json")) {
          try {
            const failure = await response.json();
            error.code = failure?.detail?.code;
          } catch {
            // The status is enough for fail-open handling; never echo an upstream body.
          }
        }
        throw error;
      }
      const contentType = response.headers.get("content-type") || "";
      return contentType.includes("application/json") ? response.json() : undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async contextPack({ query, sessionId }) {
    const result = await this.post("/v1/context-pack", {
      scope: scopeFromConfig(this.config),
      target: this.config.target,
      ...(query ? { query } : {}),
      limit: this.config.maxContextItems,
      include_global: true,
      source_platform: this.config.sourcePlatform,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    if (!result || typeof result.rendered_content !== "string") return "";
    return result.rendered_content.trim();
  }

  checkpoint({ summary, sessionId, metadata, idempotencyKey }) {
    return this.post(
      "/v1/checkpoints",
      {
        scope: scopeFromConfig(this.config),
        summary,
        source_platform: this.config.sourcePlatform,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(metadata ? { metadata } : {}),
      },
      { idempotencyKey },
    );
  }

  propose({ content, sessionId, metadata, idempotencyKey }) {
    return this.post(
      "/v1/memory/proposals",
      {
        scope: scopeFromConfig(this.config),
        content,
        explicit_user_fact: true,
        source_platform: this.config.sourcePlatform,
        metadata: {
          ...(metadata || {}),
          ...(sessionId ? { session_id: sessionId } : {}),
        },
      },
      { idempotencyKey },
    );
  }
}
