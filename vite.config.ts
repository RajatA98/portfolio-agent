import { defineConfig } from 'vite';

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
    outDir: '../../dist/client'
  }
});
