const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/giu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}\b/gu,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/giu,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|cookie)\s*[:=]\s*["']?[^\s"'`,;]{6,}["']?/giu,
];

function freshPattern(pattern) {
  return new RegExp(pattern.source, pattern.flags);
}

export function containsRecognizedSecret(text) {
  return SECRET_PATTERNS.some((pattern) => freshPattern(pattern).test(text));
}

export function protectText(text, mode = "strict") {
  const normalized = String(text ?? "").replaceAll("\u0000", "").trim();
  if (!normalized) return { text: "", dropped: false, secretDetected: false };

  const secretDetected = containsRecognizedSecret(normalized);
  if (!secretDetected) return { text: normalized, dropped: false, secretDetected: false };
  if (mode === "strict") return { text: "", dropped: true, secretDetected: true };

  let redacted = normalized;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(freshPattern(pattern), "[REDACTED_SECRET]");
  }
  return { text: redacted, dropped: false, secretDetected: true };
}

export const recognizedSecretPatternCount = SECRET_PATTERNS.length;
