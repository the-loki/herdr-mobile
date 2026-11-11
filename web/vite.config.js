import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The Node server serves `dist` in production; `npm run dev` proxies the API to
// a locally running plugin so the UI can be iterated on with hot reload.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:7777', changeOrigin: false } },
  },
});
