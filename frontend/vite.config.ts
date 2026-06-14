import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router-dom)[\\/]/.test(id)) {
            return 'vendor-react';
          }
          if (/[\\/]node_modules[\\/](@radix-ui[\\/]themes|lucide-react)[\\/]/.test(id)) {
            return 'vendor-ui';
          }
          if (/[\\/]node_modules[\\/]recharts[\\/]/.test(id)) {
            return 'vendor-charts';
          }
          if (/[\\/]node_modules[\\/]@dnd-kit[\\/]/.test(id)) {
            return 'vendor-dnd';
          }
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
});
