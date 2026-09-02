import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    proxy: { "/api": { target: process.env.LIFE_API_PROXY_TARGET ?? "http://127.0.0.1:3100", timeout: 120_000, proxyTimeout: 120_000 } },
  },
  build: {
    outDir: resolve(root, "../../dist/mobile"),
    emptyOutDir: true,
  },
});
