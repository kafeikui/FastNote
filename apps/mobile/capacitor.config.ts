import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.fastnote.mobile',
  appName: 'FastNote',
  webDir: 'dist',
  android: {
    // The WebView serves the app from https://localhost so WebCrypto / clipboard and other
    // secure-context APIs are available.
    allowMixedContent: false,
  },
};

export default config;
