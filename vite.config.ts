import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** The node server (API + WebSocket) that the dev server proxies back to. */
const SERVER_PORT = Number(process.env.PORT || 5188)

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5189,
    strictPort: true,
    // Same-origin in dev, so the client's `ws://${location.host}/ws` works
    // unchanged whether it is served by Vite or by the node server.
    proxy: {
      '/api': { target: `http://localhost:${SERVER_PORT}` },
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true },
    },
  },
})
