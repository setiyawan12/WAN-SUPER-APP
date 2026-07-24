import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { QuickChat } from "./pages/QuickChat";
import "./theme.css";
import "./styles.css";

// The quick-chat mini window (HANDBOOK M6) loads the SAME bundle at the
// "#quick" hash, so we mount the trimmed <QuickChat/> there instead of the full
// dashboard. Everything else (main window) gets the normal <App/>.
const isQuick = window.location.hash.replace(/^#/, "") === "quick";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isQuick ? <QuickChat /> : <App />}</React.StrictMode>
);
