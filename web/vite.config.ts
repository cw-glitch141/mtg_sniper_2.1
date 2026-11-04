import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: {
    port: 5173,
    // Im Entwicklungsmodus leitet Vite die API an den lokalen Server weiter.
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
