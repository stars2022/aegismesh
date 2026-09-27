import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.AIC_API_PROXY_TARGET || 'http://127.0.0.1:8000',
    },
  },
})
