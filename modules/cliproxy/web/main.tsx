import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/dm-sans/latin-400.css";
import "@fontsource/dm-sans/latin-500.css";
import "@fontsource/dm-sans/latin-600.css";
import "@fontsource/manrope/latin-600.css";
import "@fontsource/manrope/latin-700.css";
import { configureCloudRuntime } from "../renderer/transport/runtime";
import { App } from "./App";
import { firebaseAccessToken } from "./firebase";
import "./styles.css";

const routerOrigin = import.meta.env.VITE_WAN_ROUTER_ORIGIN as string | undefined;
if (!routerOrigin) throw new Error("VITE_WAN_ROUTER_ORIGIN is required for WAN Router Cloud web.");

configureCloudRuntime({
  kind: "web-cloud",
  baseUrl: routerOrigin,
  getAccessToken: firebaseAccessToken,
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>,
);