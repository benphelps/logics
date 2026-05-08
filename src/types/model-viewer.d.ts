// Minimal JSX typing for the <model-viewer> custom element from
// @google/model-viewer. We register the element by importing the package
// for its side effects; this declaration just teaches TypeScript that
// `<model-viewer>` is a valid intrinsic with a few attributes we use.

import type { DetailedHTMLProps, HTMLAttributes } from "react";

interface ModelViewerAttributes extends HTMLAttributes<HTMLElement> {
  // <model-viewer> is a Web Component — React 19 passes attributes
  // through verbatim for custom elements, so the JSX needs to use the
  // native `class` attribute (not `className`) for CSS targeting.
  // Add `class` to the typing so TS accepts it.
  class?: string;
  src?: string;
  alt?: string;
  poster?: string;
  "auto-rotate"?: boolean | "";
  "auto-rotate-delay"?: number | string;
  "rotation-per-second"?: string;
  "camera-controls"?: boolean | "";
  "interaction-prompt"?: "auto" | "when-focused" | "none";
  "shadow-intensity"?: number | string;
  "shadow-softness"?: number | string;
  "environment-image"?: string;
  "skybox-image"?: string;
  exposure?: number | string;
  "tone-mapping"?: "auto" | "aces" | "agx" | "reinhard" | "cineon" | "neutral" | "commerce" | "linear";
  "field-of-view"?: string;
  "camera-orbit"?: string;
  "min-camera-orbit"?: string;
  "max-camera-orbit"?: string;
  "disable-tap"?: boolean | "";
  "disable-zoom"?: boolean | "";
  "disable-pan"?: boolean | "";
  loading?: "auto" | "lazy" | "eager";
  reveal?: "auto" | "interaction" | "manual";
}

// React 19 moved the JSX namespace from a global into React.JSX (per the
// new types in @types/react@19). Augment that scoped namespace via the
// "react" module so <model-viewer> is recognised in JSX. The empty
// `declare global { namespace JSX {} }` block is kept for compatibility
// with any legacy global-JSX consumers; the React.JSX merge is what the
// app's tsx files actually pick up.
declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": DetailedHTMLProps<ModelViewerAttributes, HTMLElement>;
    }
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": DetailedHTMLProps<ModelViewerAttributes, HTMLElement>;
    }
  }
}

export {};
