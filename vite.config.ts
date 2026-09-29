import { defineConfig, type Plugin } from 'vite';
import { mkdirSync } from 'node:fs';
import { Store } from './src/server/store.js';
import { createApiHandler } from './src/server/app.js';

function apiPlugin(): Plugin {
  return {
    name: 'drat-proof-api',
    configureServer(server) {
      mkdirSync('data', { recursive: true });
      const store = Store.open('data/app.db');
      const handler = createApiHandler(store, 'casepack');
      server.middlewares.use('/api', handler);
    }
  };
}

export default defineConfig({
  plugins: [apiPlugin()],
  server: { strictPort: true }
});
