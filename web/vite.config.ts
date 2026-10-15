import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = process.env.DRAKOX_BACKEND ?? 'http://127.0.0.1:4545';

export default defineConfig({
  root: here,
  base: '/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(here, '../dist/web'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 5000,
    sourcemap: false,
  },
  worker: { format: 'es' },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': backend,
      '/oauth': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
});
