import crypto from "node:crypto";

import { assertNoProjectionEcho, assertNoSecrets } from "./security.mjs";

export class HubProtocolError extends Error {
  constructor(code, status) {
    super(`${code}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "HubProtocolError";
    this.code = code;
    this.status = status;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

export function idempotencyKey(kind, body) {
  return crypto
    .createHash("sha256")
    .update(`${kind}\0${JSON.stringify(stableValue(body))}`)
    .digest("hex");
}

function assertCanonicalContext(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.schema_version !== "v1" ||
    payload.delivery_state !== "prepared" ||
    !Array.isArray(payload.items) ||
    typeof payload.rendered_content !== "string"
  ) {
    throw new HubProtocolError("invalid_context_response");
  }
  if (payload.target != null || payload.setting != null) {
    throw new HubProtocolError("projection_echo_refused");
  }
  for (const item of payload.items) {
    if (
      item?.changed !== false ||
      item?.canonical_content !== item?.rendered_content ||
      item?.canonical_digest !== item?.rendered_digest
    ) {
      throw new HubProtocolError("projection_echo_refused");
    }
  }
}

export class HubClient {
  constructor(config, fetchImplementation = globalThis.fetch) {
    if (typeof fetchImplementation !== "function") {
      throw new Error("A fetch implementation is required");
    }
    this.config = config;
    this.fetch = fetchImplementation;
  }

  async post(path, body, { idempotency } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetch(`${this.config.url}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-memory-sync-source": this.config.platform,
          ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
          ...(idempotency ? { "idempotency-key": idempotency } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      let payload;
      if ((response.headers.get("content-type") || "").includes("application/json")) {
        try {
          payload = await response.json();
        } catch {
          payload = undefined;
        }
      }
      if (!response.ok) {
        throw new HubProtocolError(payload?.detail?.code || "hub_request_failed", response.status);
      }
      if (!payload || typeof payload !== "object") {
        throw new HubProtocolError("invalid_hub_response", 502);
      }
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") throw new HubProtocolError("hub_timeout");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async context({ query, sessionId, includeGlobal = true } = {}) {
    if (query) assertNoSecrets(query);
    const body = {
      scope: this.config.scope,
      ...(query ? { query: String(query).trim() } : {}),
      limit: this.config.maxItems,
      include_global: Boolean(includeGlobal),
      source_platform: this.config.platform,
      ...(sessionId ? { session_id: String(sessionId).trim() } : {}),
    };
    const payload = await this.post("/v1/context-pack", body);
    assertCanonicalContext(payload);
    return {
      text: payload.rendered_content.trim(),
      items: payload.items,
      deliveryState: payload.delivery_state,
    };
  }

  async propose({ content, sessionId, metadata = {} }) {
    if (!this.config.writeEnabled) throw new HubProtocolError("write_disabled");
    assertNoSecrets(content);
    assertNoSecrets(metadata);
    assertNoProjectionEcho(metadata);
    const body = {
      scope: this.config.scope,
      content: String(content).trim(),
      explicit_user_fact: false,
      source_platform: this.config.platform,
      metadata: {
        ...metadata,
        ...(sessionId ? { session_id: String(sessionId).trim() } : {}),
      },
    };
    return this.post("/v1/memory/proposals", body, {
      idempotency: idempotencyKey("proposal", body),
    });
  }

  async checkpoint({ summary, sessionId, metadata = {} }) {
    if (!this.config.writeEnabled) throw new HubProtocolError("write_disabled");
    assertNoSecrets(summary);
    assertNoSecrets(metadata);
    assertNoProjectionEcho(metadata);
    const body = {
      scope: this.config.scope,
      summary: String(summary).trim(),
      source_platform: this.config.platform,
      ...(sessionId ? { session_id: String(sessionId).trim() } : {}),
      metadata,
    };
    return this.post("/v1/checkpoints", body, {
      idempotency: idempotencyKey("checkpoint", body),
    });
  }
}
