import { defineConfig } from 'vite';

// Base path support for static hosting under a sub-path, e.g.
//   SKYBOUND_BASE=/skybound/ npm run build
// GitHub Pages: set SKYBOUND_BASE to "/<repo-name>/".
const base = process.env.SKYBOUND_BASE ?? './';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
