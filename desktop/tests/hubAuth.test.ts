import { describe, expect, it } from "vitest";

import { withHubAuthorization } from "../src/hubAuth";

describe("withHubAuthorization", () => {
  it("adds the private bearer only to the exact Hub origin", () => {
    expect(
      withHubAuthorization(
        "http://127.0.0.1:8787/v1/memories",
        {
          Accept: "application/json",
          authorization: "Bearer renderer-controlled-value",
        },
        "private-token",
      ),
    ).toEqual({
      Accept: "application/json",
      Authorization: "Bearer private-token",
    });
  });

  it("never sends the bearer to lookalike or external origins", () => {
    const original = { Accept: "application/json" };
    expect(
      withHubAuthorization(
        "http://127.0.0.1.attacker.example:8787/v1/memories",
        original,
        "private-token",
      ),
    ).toBe(original);
    expect(
      withHubAuthorization(
        "https://github.com/miku233333/aiagent-memoryhub/releases",
        original,
        "private-token",
      ),
    ).toBe(original);
  });

  it("keeps the bearer off tokenless health and static resources", () => {
    const original = { Accept: "text/html" };
    expect(
      withHubAuthorization(
        "http://127.0.0.1:8787/health",
        original,
        "private-token",
      ),
    ).toBe(original);
    expect(
      withHubAuthorization(
        "http://127.0.0.1:8787/assets/index.js",
        original,
        "private-token",
      ),
    ).toBe(original);
  });
});
