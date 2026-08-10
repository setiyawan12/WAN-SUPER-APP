import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  const hostingBuild = env.CLIPROXY_WEB_HOSTING === "true";
  const routerUrl = env.VITE_WAN_ROUTER_ORIGIN || "http://127.0.0.1:8080";
  const routerOrigin = new URL(routerUrl).origin;
  const firebaseAuthOrigin = env.VITE_FIREBASE_AUTH_EMULATOR_HOST
    ? new URL(env.VITE_FIREBASE_AUTH_EMULATOR_HOST).origin
    : "";
  if (hostingBuild && !env.VITE_WAN_ROUTER_ORIGIN) {
    throw new Error("VITE_WAN_ROUTER_ORIGIN is required for a Cliproxy web hosting build.");
  }

  return {
    root: path.join(__dirname, "modules/cliproxy/web"),
    base: hostingBuild ? "/" : "./",
    plugins: [
      react(),
      {
        name: "wan-router-csp",
        transformIndexHtml(html) {
          return html
            .replaceAll("__WAN_ROUTER_ORIGIN__", routerOrigin)
            .replaceAll("__FIREBASE_AUTH_ORIGIN__", firebaseAuthOrigin);
        },
      },
    ],
    build: {
      outDir: hostingBuild
        ? path.join(__dirname, "firebase/hosting/cliproxy")
        : path.join(__dirname, "out/modules/cliproxy/web"),
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules/firebase") || id.includes("node_modules/@firebase")) return "firebase";
            if (id.includes("react-markdown") || id.includes("remark-") || id.includes("rehype-")) return "markdown";
            return undefined;
          },
        },
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5178,
      strictPort: true,
    },
  };
});