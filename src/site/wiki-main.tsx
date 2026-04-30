import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Wiki } from "./Wiki";
import "./site.css";
import "./wiki.css";

createRoot(document.getElementById("wiki-root")!).render(
  <StrictMode>
    <Wiki />
  </StrictMode>,
);
