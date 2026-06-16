import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['microsoft-cognitiveservices-speech-sdk'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Three.js core — large and changes rarely, benefits from long-term caching
          'three': ['three'],
          // R3F + Drei — separate from app code for the same reason
          'r3f': ['@react-three/fiber', '@react-three/drei'],
          // Azure Speech SDK — only loaded on first TTS call via dynamic import
          // Rollup will auto-split it; no manual entry needed here
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': process.env.VERCEL_DEV ? 'http://localhost:3000' : 'http://localhost:3001',
    },
  },
})
