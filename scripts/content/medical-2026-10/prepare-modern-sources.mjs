import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { modernDrugs } from './modern-drugs.mjs';
const folder = resolve(import.meta.dirname, '../../../data/content-cache/medical-2026-10');
await mkdir(folder, { recursive: true });
await writeFile(resolve(folder, 'modern-drugs-input.json'), JSON.stringify(modernDrugs, null, 2));
console.log(JSON.stringify({ modernDrugs: modernDrugs.length, output: 'data/content-cache/medical-2026-10/modern-drugs-input.json' }));
