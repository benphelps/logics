import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { headshotDevServerPlugin } from "./server/headshots";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), headshotDevServerPlugin()],
  build: {
    rollupOptions: {
      input: {
        game: resolve(__dirname, "index.html"),
        website: resolve(__dirname, "website.html"),
      },
    },
  },
});
