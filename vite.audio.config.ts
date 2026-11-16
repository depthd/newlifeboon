import { defineConfig } from 'vite';
export default defineConfig({
  build: { outDir: 'dist-audio', rollupOptions: { input: 'audio-lab.html' } },
  worker: { format: 'es' },
});
