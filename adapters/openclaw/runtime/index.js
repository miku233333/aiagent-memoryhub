import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { HubClient, formatContext, loadConfig } from "@omnimemory/adapter-runtime";

import { createPlugin } from "../src/plugin-factory.mjs";

export default createPlugin({
  definePluginEntry,
  formatContext,
  clientFactory: () =>
    new HubClient(loadConfig({ ...process.env, MEMORY_HUB_PLATFORM: "openclaw" })),
});
