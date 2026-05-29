import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import "@vscode/codicons/dist/codicon.css";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element in index.html");

// Last-resort handlers for promise rejections / window errors that
// never made it to a component. Logged with a `[Goonware]` prefix so they
// stand out from any third-party noise during postmortem.
window.addEventListener("error", (e) => {
  // eslint-disable-next-line no-console
  console.error("[Goonware] window error:", e.error ?? e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  // eslint-disable-next-line no-console
  console.error("[Goonware] unhandled rejection:", e.reason);
});

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
