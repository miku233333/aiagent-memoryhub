import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const hubToken = process.env.MEMORY_HUB_TOKEN?.trim();
const hubProxy = {
  target: "http://127.0.0.1:8787",
  ...(hubToken === undefined || hubToken.length === 0
    ? {}
    : { headers: { Authorization: `Bearer ${hubToken}` } }),
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    strictPort: true,
    proxy: {
      "/health": "http://127.0.0.1:8787",
      "/v1": hubProxy,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
  },
});
