import { describe, expect, it } from "vitest";

import { classifyNavigation } from "../src/navigationPolicy";

describe("classifyNavigation", () => {
  it("allows only the fixed loopback Hub origin in the app window", () => {
    expect(classifyNavigation("http://127.0.0.1:8787/overview?tab=sync#top")).toBe(
      "allow-local",
    );

    for (const url of [
      "http://localhost:8787/",
      "http://127.0.0.1:8788/",
      "https://127.0.0.1:8787/",
      "http://user:secret@127.0.0.1:8787/",
      "file:///tmp/index.html",
      "javascript:alert(1)",
    ]) {
      expect(classifyNavigation(url), url).toBe("deny");
    }
  });

  it("opens only the exact HTTPS GitHub repository release area externally", () => {
    expect(
      classifyNavigation(
        "https://github.com/miku233333/aiagent-memoryhub/releases/tag/v0.2.0",
      ),
    ).toBe("open-release-external");
    expect(
      classifyNavigation(
        "https://github.com/miku233333/aiagent-memoryhub/releases",
      ),
    ).toBe("open-release-external");

    for (const url of [
      "http://github.com/miku233333/aiagent-memoryhub/releases",
      "https://github.com.evil.example/miku233333/aiagent-memoryhub/releases",
      "https://github.com/other/aiagent-memoryhub/releases",
      "https://github.com/miku233333/other/releases",
      "https://github.com/miku233333/aiagent-memoryhub/releases-evil",
      "https://user:secret@github.com/miku233333/aiagent-memoryhub/releases",
      "https://github.com:444/miku233333/aiagent-memoryhub/releases",
    ]) {
      expect(classifyNavigation(url), url).toBe("deny");
    }
  });

  it("fails closed for malformed URLs", () => {
    expect(classifyNavigation("not a URL")).toBe("deny");
    expect(classifyNavigation("")).toBe("deny");
  });
});
