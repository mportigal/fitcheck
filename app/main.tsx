import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installWebMCP } from "./webmcp";
import "./styles.css";

installWebMCP();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
