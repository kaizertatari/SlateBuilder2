import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // `npm run dev` runs plain Vite, which doesn't serve /api routes. Proxy
    // them to a sibling `vercel dev` (port 3000). If you run `vercel dev`
    // by itself it handles both the SPA and the functions, so this proxy
    // is a no-op in that mode.
    //
    // Bypass: src/App.jsx imports workspace files from ../api/_lib/*.js as
    // native ESM. Those resolve to URLs like /api/_lib/prop-types.js. If we
    // proxy them, vercel dev 404s (it only knows function routes). Returning
    // the URL from bypass tells Vite to serve it from the filesystem instead.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        bypass: (req) => {
          if (req.url && /\.(js|mjs|ts|tsx|jsx)(\?|$)/.test(req.url)) {
            return req.url;
          }
          return null;
        },
      },
    },
  },
})