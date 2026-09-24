import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { apiPlugin } from './src/server/server';

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: { host: '127.0.0.1', port: 5391, strictPort: true },
});
