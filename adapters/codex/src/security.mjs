const SECRET_PATTERNS = [
  {
    name: "private_key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
  },
  {
    name: "bearer_token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  },
  {
    name: "vendor_api_key",
    pattern: /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{24,})\b/g,
  },
  {
    name: "credential_assignment",
    pattern: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|cookie)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi,
  },
];

const PROJECTION_KEYS = new Set([
  "projection_echo",
  "projection_target",
  "canonical_content",
  "rendered_content",
  "canonical_digest",
  "rendered_digest",
  "applied_rules",
  "cross_cultural_polish",
]);

export class AdapterSafetyError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "AdapterSafetyError";
    this.code = code;
  }
}

function matches(pattern, text) {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

export function detectSecrets(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  return SECRET_PATTERNS.filter(({ pattern }) => matches(pattern, text)).map(({ name }) => name);
}

export function assertNoSecrets(value) {
  const detectors = detectSecrets(value);
  if (detectors.length) {
    throw new AdapterSafetyError("secret_detected", detectors.join(","));
  }
}

export function redactSecrets(value) {
  let text = String(value ?? "");
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (name === "credential_assignment") {
      text = text.replace(pattern, (_match, key) => `${key}=[REDACTED]`);
    } else {
      text = text.replace(pattern, "[REDACTED]");
    }
  }
  return text;
}

function findProjectionMarker(value, path = "metadata") {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findProjectionMarker(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^(memory_hub_)?projection$/i.test(value.trim())) {
      return path;
    }
    return undefined;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (PROJECTION_KEYS.has(key.toLowerCase())) return `${path}.${key}`;
    const found = findProjectionMarker(nested, `${path}.${key}`);
    if (found) return found;
  }
  return undefined;
}

export function assertNoProjectionEcho(metadata) {
  const marker = findProjectionMarker(metadata ?? {});
  if (marker) {
    throw new AdapterSafetyError("projection_echo_refused", marker);
  }
}
