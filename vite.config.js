import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // `npm run dev` runs plain Vite, which doesn't serve /api routes. Proxy
    // them to a sibling `vercel dev` (port 3000). If you run `vercel dev`
    // by itself it handles both the SPA and the functions, so this proxy
    // is a no-op in that mode.
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})