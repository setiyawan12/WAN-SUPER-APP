import React from "react";
import ReactDOM from "react-dom/client";
import WebRoot from "./WebRoot";
import { ConfirmProvider } from "./ui";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfirmProvider>
      <WebRoot />
    </ConfirmProvider>
  </React.StrictMode>
);