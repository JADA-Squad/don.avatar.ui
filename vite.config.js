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
        manualChunks(id) {
          if (id.includes('node_modules/three/')) return 'three';
          if (id.includes('@react-three/fiber') || id.includes('@react-three/drei')) return 'r3f';
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
