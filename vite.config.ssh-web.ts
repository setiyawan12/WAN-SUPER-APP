import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = path.resolve(__dirname, "modules/ssh/ui");
const connectSource = process.env.WAN_SSH_WEB_CONNECT_SRC ?? "'self' ws://127.0.0.1:5179";
const firebaseAuthEmulatorSource = process.env.VITE_FIREBASE_AUTH_EMULATOR_HOST ?? "";
const firebaseAuthSources = "https://identitytoolkit.googleapis.com https://securetoken.googleapis.com";

export default defineConfig({
  root,
  base: "/",
  plugins: [
    react(),
    {
      name: "wan-ssh-web-entry",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          return html
            .replace("/src/main.tsx", "/src/main.web.tsx")
            .replace("<title>WANN-SSH</title>", "<title>WAN SSH Web Gateway</title>")
            .replace(
              /content="default-src[^\"]+"/,
              `content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src ${connectSource} ${firebaseAuthSources} ${firebaseAuthEmulatorSource}; img-src 'self' data:; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'"`
            );
        }
      }
    }
  ],
  build: {
    outDir: path.resolve(__dirname, "firebase/hosting/ssh"),
    emptyOutDir: true,
    sourcemap: false
  }
});