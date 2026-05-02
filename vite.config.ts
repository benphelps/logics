import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { headshotDevServerPlugin } from "./server/headshots";
import { shipArtDevServerPlugin } from "./server/ship-art";
import { syndicateInsigniaDevServerPlugin } from "./server/syndicate-insignia";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), headshotDevServerPlugin(), shipArtDevServerPlugin(), syndicateInsigniaDevServerPlugin()],
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
