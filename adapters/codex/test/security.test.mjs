import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoProjectionEcho,
  assertNoSecrets,
  redactSecrets,
} from "../src/security.mjs";

test("secret failures identify detectors without repeating the secret", () => {
  const secret = "sk-" + "ant-api03-abcdefghijklmnopqrstuvwxyz123456";
  assert.throws(
    () => assertNoSecrets(`token=${secret}`),
    (error) => {
      assert.equal(error.code, "secret_detected");
      assert.match(error.message, /credential_assignment/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  assert.equal(redactSecrets(`token=${secret}`), "token=[REDACTED]");
});

test("projection-derived metadata cannot be written back as canonical memory", () => {
  assert.throws(
    () =>
      assertNoProjectionEcho({
        source: "hook",
        nested: { rendered_digest: "abc" },
      }),
    (error) => error.code === "projection_echo_refused",
  );

  assert.doesNotThrow(() =>
    assertNoProjectionEcho({ session_id: "s-1", source_event: "Stop" }),
  );
});
