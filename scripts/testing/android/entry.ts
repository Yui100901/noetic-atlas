// Extra Vite entry for the separate .qa APK only. Never included by production
// vite.mobile.config.ts; the builder restores production Android assets finally.
export { nativeFetch } from '../../../mobile/platform';
export { downloadExport } from '../../../web/shared/export/export-download';
