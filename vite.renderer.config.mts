import path from 'node:path';
import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  // The renderer lives in src/renderer (index.html is the entry).
  root: path.join(import.meta.dirname, 'src/renderer'),
  build: {
    // Forge's default outDir is relative and would resolve inside the custom
    // root — pin it back to the project-level .vite dir the main process
    // (and packaging) expect.
    outDir: path.join(import.meta.dirname, '.vite/renderer/main_window'),
    emptyOutDir: true,
  },
});
