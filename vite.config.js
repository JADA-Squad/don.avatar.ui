import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The Azure Speech SDK ships as a CJS bundle — Vite must pre-bundle it into ESM
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['microsoft-cognitiveservices-speech-sdk'],
  },
  server: {
    // In dev, proxy /api calls to vercel dev (port 3000) or fallback to Express server (port 3001)
    proxy: {
      '/api': process.env.VERCEL_DEV ? 'http://localhost:3000' : 'http://localhost:3001',
    },
  },
})
