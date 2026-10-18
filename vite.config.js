import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  build: {
    rollupOptions: {
      output: {
        // The vendor code changes only on a dependency bump; splitting it
        // out keeps the hashed filenames stable across app deploys, so the
        // service worker's cache keeps serving them instead of refetching
        // a megabyte after every change to one page.
        // Rolldown (vite 8) takes the function form only.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return 'react'
          if (id.includes('node_modules/@supabase/')) return 'supabase'
          return undefined
        },
      },
    },
  },
})
