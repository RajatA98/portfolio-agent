import { defineConfig } from 'vite';
import { resolve } from 'path';

const agentPort = '3334';

export default defineConfig({
  root: 'src/client',
  envDir: '../..',
  server: {
    port: 5179,
    proxy: {
      '/api': `http://127.0.0.1:${agentPort}`,
      '/health': `http://127.0.0.1:${agentPort}`
    },
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    }
  },
  build: {
    outDir: '../../dist/client',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/client/index.html'),
        landing: resolve(__dirname, 'src/client/landing.html'),
        terms: resolve(__dirname, 'src/client/terms.html'),
        privacy: resolve(__dirname, 'src/client/privacy.html')
      }
    }
  }
});
