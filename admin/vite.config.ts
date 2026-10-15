import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /api/* goes to mandipos-api: in production through vercel.json's rewrite, locally to the
// API started with POS_API (default: the local admin-enabled API on 3032).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.POS_API ?? 'http://localhost:3032',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
