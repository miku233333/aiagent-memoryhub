import { describe, expect, it } from "vitest";

import { assertTrustedIpcRequest } from "../src/ipcPolicy";

describe("assertTrustedIpcRequest", () => {
  it("accepts only argument-free calls from the top-level fixed Hub origin", () => {
    expect(() =>
      assertTrustedIpcRequest({
        argumentCount: 0,
        frameURL: "http://127.0.0.1:8787/environment",
        isTopLevelFrame: true,
      }),
    ).not.toThrow();

    for (const request of [
      {
        argumentCount: 0,
        frameURL: "https://evil.example/",
        isTopLevelFrame: true,
      },
      {
        argumentCount: 0,
        frameURL: "http://127.0.0.1:8787/",
        isTopLevelFrame: false,
      },
      {
        argumentCount: 1,
        frameURL: "http://127.0.0.1:8787/",
        isTopLevelFrame: true,
      },
      { argumentCount: 0, frameURL: null, isTopLevelFrame: false },
    ]) {
      expect(() => assertTrustedIpcRequest(request), JSON.stringify(request)).toThrow();
    }
  });
});
