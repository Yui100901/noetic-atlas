import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: [{ find: /^@platform$/, replacement: fileURLToPath(new URL('./web/shared/lib/platform.ts', import.meta.url)) }] },
  build: { manifest: true, outDir: 'dist/web', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': {
    target: 'http://127.0.0.1:4317', changeOrigin: false,
    configure(proxy) {
      // Keep the browser-facing host so the API can enforce its same-origin
      // write checks in development exactly as it does in production.
      proxy.on('proxyReq', (outgoing, incoming) => {
        if (incoming.headers.host) outgoing.setHeader('host', incoming.headers.host);
      });
    },
  } } },
});
