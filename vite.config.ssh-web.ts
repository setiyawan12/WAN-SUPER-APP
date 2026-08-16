import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = path.resolve(__dirname, "modules/ssh/ui");
const connectSource = process.env.WAN_SSH_WEB_CONNECT_SRC ?? "'self' ws://127.0.0.1:5179 ws://localhost:5179";
const firebaseAuthEmulatorSource = process.env.VITE_FIREBASE_AUTH_EMULATOR_HOST ?? "";
const firebaseDatabaseEmulatorSource = process.env.VITE_FIREBASE_DATABASE_EMULATOR_HOST ?? "";
const firebaseAuthSources = "https://identitytoolkit.googleapis.com https://securetoken.googleapis.com";
const firebaseDatabaseSources = "https://*.firebaseio.com wss://*.firebaseio.com https://*.firebasedatabase.app wss://*.firebasedatabase.app";
// Google sign-in memuat gapi dari apis.google.com, auth handler iframe pada
// authDomain Firebase, dan avatar profil dari googleusercontent.
const firebaseScriptSources = "https://apis.google.com";
const firebaseFrameSources = [
  "https://*.firebaseapp.com",
  "https://*.web.app",
  "https://*.firebaseio.com",
  "https://*.firebasedatabase.app",
  "https://accounts.google.com",
  "https://apis.google.com",
  firebaseAuthEmulatorSource
].filter(Boolean).join(" ");
const profileImageSources = "https://*.googleusercontent.com";
// Dev server memakai origin yang sama dengan gateway, seperti reverse proxy
// produksi. Diaktifkan hanya bila WAN_SSH_GATEWAY_ORIGIN diisi.
const gatewayOrigin = process.env.WAN_SSH_GATEWAY_ORIGIN ?? "";
const devProxy = gatewayOrigin
  ? {
      "/healthz": { target: gatewayOrigin },
      "/readyz": { target: gatewayOrigin },
      "/runtime-config.json": { target: gatewayOrigin },
      "/metrics": { target: gatewayOrigin },
      "/v1/ws": { target: gatewayOrigin, ws: true }
    }
  : undefined;

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
              `content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval' ${firebaseScriptSources} ${firebaseDatabaseSources}; style-src 'self' 'unsafe-inline'; connect-src ${connectSource} ${firebaseAuthSources} ${firebaseDatabaseSources} ${firebaseAuthEmulatorSource} ${firebaseDatabaseEmulatorSource}; frame-src ${firebaseFrameSources}; img-src 'self' data: ${profileImageSources}; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'"`
            );
        }
      }
    }
  ],
  server: devProxy ? { proxy: devProxy } : undefined,
  build: {
    outDir: path.resolve(__dirname, "firebase/hosting/ssh"),
    emptyOutDir: true,
    sourcemap: false
  }
});