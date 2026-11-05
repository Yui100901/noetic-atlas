import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'cn.noetic.atlas', appName: '认知星图', webDir: 'dist/mobile',
  // Native plugin payloads may contain API credentials or private study text.
  loggingBehavior: 'none',
  // No server.url, remote host, live reload, Node process or LAN dependency.
  server: { androidScheme: 'https' },
  android: { allowMixedContent: false, backgroundColor: '#f4f5f9' },
  plugins: { App: { disableBackButtonHandler: true }, SystemBars: { initialViewportFitValueHint: 'cover', insetsHandling: 'css', style: 'LIGHT' } },
};
export default config;
