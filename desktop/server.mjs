// Shipped outside app.asar, alongside the compiled server and its production
// dependencies. The executable is official Node 24, never Electron's Node ABI.
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';

let app, starting = false, closing = false;
async function close() {
  if (closing) return; closing = true;
  try { if (app) await app.close(); } finally { process.exit(0); }
}
process.on('disconnect', () => void close());
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
process.on('message', async message => {
  if (message?.type === 'shutdown') { await close(); return; }
  if (message?.type !== 'start' || starting || closing) return;
  starting = true;
  try {
    if (typeof message.dataDirectory !== 'string' || !isAbsolute(message.dataDirectory)) throw new Error('Invalid data directory');
    const dataDirectory = resolve(message.dataDirectory);
    mkdirSync(dataDirectory, { recursive: true });
    const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const { buildApp } = await import(pathToFileURL(join(serverRoot, 'dist', 'server', 'index.js')).href);
    if (closing) return;
    delete process.env.SEED_PATH;
    app = await buildApp({ databasePath: join(dataDirectory, 'noetic-atlas.sqlite'), staticRoot: join(serverRoot, 'dist', 'web'), logger: false });
    if (closing) { await app.close(); return; }
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Invalid local address');
    if (process.connected) process.send({ type: 'ready', port: address.port });
    else await close();
  } catch {
    // Never forward exception stacks or provider settings through the UI/logs.
    if (process.connected) process.send({ type: 'startup-error' });
    try { if (app) await app.close(); } finally { process.exit(1); }
  }
});
if (!process.send) process.exit(1);
