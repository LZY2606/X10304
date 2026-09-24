import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: { middlewareMode: true },
  appType: 'custom',
  build: { outDir: 'dist' },
});
