import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite on 5173 proxies /api to the db-audit server (npm start, port 4000).
// Build: web/dist, served by the server with SPA fallback.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.DB_AUDIT_API ?? 'http://127.0.0.1:4000', changeOrigin: false },
    },
  },
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
});
