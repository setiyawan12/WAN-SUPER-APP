import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostingBuild = process.env.MINDMAP_HOSTING === "true";

const desktopInputs = {
  index: path.join(__dirname, "modules/mindmap/ui/index.html"),
  group: path.join(__dirname, "modules/mindmap/ui/group.html"),
  invite: path.join(__dirname, "modules/mindmap/ui/invite.html"),
  login: path.join(__dirname, "modules/mindmap/ui/login.html"),
  signup: path.join(__dirname, "modules/mindmap/ui/signup.html"),
  "forgot-password": path.join(__dirname, "modules/mindmap/ui/forgot-password.html"),
  "change-password": path.join(__dirname, "modules/mindmap/ui/change-password.html"),
  admin: path.join(__dirname, "modules/mindmap/ui/admin.html"),
  share: path.join(__dirname, "modules/mindmap/ui/share.html"),
  "public-share": path.join(__dirname, "modules/mindmap/ui/public-share.html"),
};

export default defineConfig({
  root: path.join(__dirname, "modules/mindmap/ui"),
  base: hostingBuild ? "/app/" : "./",
  build: {
    outDir: hostingBuild
      ? path.join(__dirname, "firebase/hosting/app")
      : path.join(__dirname, "out/modules/mindmap/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: desktopInputs,
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/firebase") || id.includes("node_modules/@firebase")) {
            return "firebase";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5176,
    strictPort: true,
  },
});