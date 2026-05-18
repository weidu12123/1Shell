import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ mode }) => ({
  plugins: [vue()],
  base: mode === 'production' ? '/app/' : '/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: process.env.VITE_DEV_PROXY_TARGET || 'http://localhost:3301', changeOrigin: true },
      '/socket.io': { target: process.env.VITE_DEV_PROXY_TARGET || 'http://localhost:3301', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
}));
