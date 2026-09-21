import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": `http://localhost:${process.env.GRANDTOUR_API_PORT ?? 8787}`,
      "/uploads": `http://localhost:${process.env.GRANDTOUR_API_PORT ?? 8787}`,
      // The distribution files: in development this origin is a GrandTour
      // server by proxying the authoring server's live index and bundles.
      "/grandtour.json": `http://localhost:${process.env.GRANDTOUR_API_PORT ?? 8787}`,
      "/tours": `http://localhost:${process.env.GRANDTOUR_API_PORT ?? 8787}`,
    },
  },
});
