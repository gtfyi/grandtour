import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Proxy API calls to the GrandTour server in dev.
      "/api": `http://localhost:${process.env.GRANDTOUR_API_PORT ?? 8787}`,
    },
  },
});
