import { fileURLToPath } from 'node:url';
export const nativeAliases = [
  ...['sqlite', 'fs', 'path', 'os', 'crypto'].map(name => ({ find: `node:${name}`, replacement: fileURLToPath(new URL(`./shims/${name}.ts`, import.meta.url)) })),
  { find: /^fastify$/, replacement: fileURLToPath(new URL('./shims/fastify.ts', import.meta.url)) },
  { find: /^@fastify\/static$/, replacement: fileURLToPath(new URL('./shims/static.ts', import.meta.url)) },
  { find: /^@fastify\/swagger(?:-ui)?$/, replacement: fileURLToPath(new URL('./shims/unused-plugin.ts', import.meta.url)) },
  // Parse Markdown in the runtime as well as the UI. The DOM-free decoder is
  // identical in Node-based WASM checks and native WebViews.
  { find: /^decode-named-character-reference$/, replacement: fileURLToPath(new URL('../node_modules/decode-named-character-reference/index.js', import.meta.url)) },
  { find: /^@platform$/, replacement: fileURLToPath(new URL('./platform.ts', import.meta.url)) },
];
