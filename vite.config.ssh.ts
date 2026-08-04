import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = path.resolve(__dirname, "modules/ssh/ui");

export default defineConfig({
  root,
  base: "./",
  plugins: [
    react(),
    {
      name: "ssh-dev-csp",
      transformIndexHtml(html, context) {
        if (!context.server) return html;
        return html.replace(
          "connect-src https://*.googleapis.com",
          "connect-src https://*.googleapis.com ws://127.0.0.1:* ws://localhost:*"
        );
      }
    }
  ],
  build: {
    outDir: process.env.SSH_RENDERER_OUT
      ? path.resolve(process.env.SSH_RENDERER_OUT)
      : path.resolve(__dirname, "modules/ssh/renderer"),
    emptyOutDir: true
  }
});