import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { Repo } from './repo.js';
import { createApiHandler } from './api.js';
import { seedCasePack } from './casepack.js';

function argValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const host = argValue(args, '--host') ?? '127.0.0.1';
  const port = Number(argValue(args, '--port') ?? '5391');
  const strictPort = args.includes('--strictPort');

  const dataDir = join(process.cwd(), 'data');
  mkdirSync(dataDir, { recursive: true });
  if (args.includes('--fresh') && existsSync(join(dataDir, 'app.db'))) rmSync(join(dataDir, 'app.db'));
  const repo = Repo.open(join(dataDir, 'app.db'));
  if (repo.listCases().length === 0) {
    seedCasePack(repo, join(process.cwd(), 'fixtures', 'proof-trace-desk'));
    console.log('[seed] proof-trace-desk case pack loaded');
  }
  const api = createApiHandler(repo);

  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom' });
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/')) {
      void api(req, res);
      return;
    }
    vite.middlewares(req, res, () => {
      res.writeHead(404); res.end('not found');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err) => {
      if (strictPort) reject(err);
      else resolve();
    });
    server.listen(port, host, () => resolve());
  });
  console.log(`proof-trace-desk listening on http://${host}:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
