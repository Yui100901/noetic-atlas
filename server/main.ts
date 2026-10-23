import { buildApp } from './index.js';

const app = await buildApp({ logger: true });
const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 须为 1～65535 的整数');
const host = process.env.HOST || '127.0.0.1';
await app.listen({ port, host });
let closing = false;
const close = async () => { if (closing) return; closing = true; await app.close(); };
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
