import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(__dirname, "modules/cliproxy/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.join(__dirname, "out/modules/cliproxy/renderer"),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
