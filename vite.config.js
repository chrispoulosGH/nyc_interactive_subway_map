import { defineConfig } from 'vite'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
