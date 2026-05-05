import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { headshotDevServerPlugin } from "./server/headshots";
import { newsDevServerPlugin } from "./server/news";
import { shipArtDevServerPlugin } from "./server/ship-art";
import { syndicateInsigniaDevServerPlugin } from "./server/syndicate-insignia";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    headshotDevServerPlugin(),
    shipArtDevServerPlugin(),
    syndicateInsigniaDevServerPlugin(),
    newsDevServerPlugin(),
    chiptuneWorkletAssetPlugin(),
  ],
  build: {
    rollupOptions: {
      input: {
        game: resolve(__dirname, "index.html"),
        website: resolve(__dirname, "website.html"),
        wiki: resolve(__dirname, "wiki.html"),
      },
    },
  },
});

function chiptuneWorkletAssetPlugin(): Plugin {
  return {
    name: "ledgway-chiptune-worklet-asset",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "assets/libopenmpt.worklet.js",
        source: readFileSync(resolve(__dirname, "node_modules/chiptune3/libopenmpt.worklet.js"), "utf8"),
      });
    },
  };
}
