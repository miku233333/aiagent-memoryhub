export class HubRestError extends Error {
  constructor(status, code = "hub_request_failed") {
    super(`Memory Hub request failed with HTTP ${status}`);
    this.name = "HubRestError";
    this.status = status;
    this.code = code;
  }
}

export class HubRestClient {
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
          "x-memory-sync-target": "claude_web",
          ...(this.config.hubToken
            ? { authorization: `Bearer ${this.config.hubToken}` }
            : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      let parsed;
      if ((response.headers.get("content-type") || "").includes("application/json")) {
        try {
          parsed = await response.json();
        } catch {
          parsed = undefined;
        }
      }
      if (!response.ok) {
        throw new HubRestError(response.status, parsed?.detail?.code);
      }
      if (!parsed || typeof parsed !== "object") {
        throw new HubRestError(502, "invalid_hub_response");
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }
}
