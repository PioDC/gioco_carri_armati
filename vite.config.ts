import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  build: {
    outDir: "../dist/client",
    emptyOutDir: true
  },
  server: {
    host: "0.0.0.0",
    port: 5173
  }
});
