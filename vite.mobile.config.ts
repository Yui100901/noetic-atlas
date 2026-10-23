import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nativeAliases } from './mobile/vite-aliases.ts';
export default defineConfig({
  plugins: [react(), { name: 'native-safe-area', transformIndexHtml: html => html.replace('width=device-width, initial-scale=1.0', 'width=device-width, initial-scale=1.0, viewport-fit=cover') }],
  resolve: { alias: nativeAliases }, define: { 'process.env': '{}' }, publicDir: 'mobile/assets',
  build: { outDir: 'dist/mobile', emptyOutDir: true, target: 'es2022' },
});
