import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: 'cn.noetic.atlas', appName: '认知星图', webDir: 'dist/mobile',
  // No server.url, remote host, live reload, Node process or LAN dependency.
  server: { androidScheme: 'https' },
  android: { allowMixedContent: false, backgroundColor: '#f4f5f9' },
  plugins: { SystemBars: { initialViewportFitValueHint: 'cover', insetsHandling: 'css', style: 'LIGHT' } },
};
export default config;
