import { defineConfig } from 'vitest/config';

export default defineConfig({
  // index.html lives in src/, so that is the Vite root; the build still goes to ./dist.
  root: 'src',
  // Relative base so the built site works from any sub-path (GitHub Pages, gpeters.com/music/).
  base: './',
  build: { target: 'es2022', outDir: '../dist', emptyOutDir: true },
  // Tests live outside src/, so point Vitest back at the project root.
  test: { root: '.', include: ['test/**/*.test.ts'] },
});
