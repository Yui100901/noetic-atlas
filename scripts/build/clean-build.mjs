import { resolve } from 'node:path';
import { preflightGeneratedDirectory, resetGeneratedDirectory } from './generated-paths.mjs';

const root = resolve(import.meta.dirname, '../..');
const outputs = ['dist/server', 'dist/shared', 'dist/web'];
for (const name of outputs) await preflightGeneratedDirectory(root, name);
for (const name of outputs) await resetGeneratedDirectory(root, name);
