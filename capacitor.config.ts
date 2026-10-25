import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.j3fx.messenger',
  appName: 'J3FX Messenger',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
}

export default config
