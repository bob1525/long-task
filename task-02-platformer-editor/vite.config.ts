import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
})
