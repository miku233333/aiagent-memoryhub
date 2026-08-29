import assert from "node:assert/strict";
import test from "node:test";

import { createPlugin } from "../src/plugin-factory.mjs";

test("plugin registers one prompt-context hook and injects reviewed data", async () => {
  const hooks = new Map();
  const plugin = createPlugin({
    definePluginEntry: (entry) => entry,
    formatContext: (text) => `[reviewed] ${text}`,
    clientFactory: () => ({ context: async () => ({ text: "Use PostgreSQL" }) }),
  });
  plugin.register({ on: (name, handler, options) => hooks.set(name, { handler, options }) });

  assert.deepEqual([...hooks.keys()], ["before_prompt_build"]);
  const result = await hooks.get("before_prompt_build").handler(
    { prompt: "database" },
    { sessionId: "s-1" },
  );
  assert.deepEqual(result, { prependContext: "[reviewed] Use PostgreSQL" });
});
