import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// No `npm run dev`, a tela roda no Vite (5173) e as chamadas vão para o receptor (8000).
const receptor = `http://localhost:${process.env.SMVEP_PORTA ?? 8000}`;

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": receptor,
      "/fotos": receptor,
    },
  },
});
