import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: { input: { city: 'index.html', trial: 'trial.html' } },
  },
});
