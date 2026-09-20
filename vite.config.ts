import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  // index.html lives in src/, so that is the Vite root; the build still goes to ./dist.
  root: 'src',
  // Relative base so the built site works from any sub-path (GitHub Pages, gpeters.com/music/).
  base: './',
  build: { target: 'es2022', outDir: '../dist', emptyOutDir: true },
  server: {
    // `npm run dev:phone` turns live reload off by dropping the dev server's websocket. The dev
    // page keeps that socket open, and when it drops and comes back the page reloads itself. A
    // phone drops it whenever the tab goes to the background, which is what opening the file
    // picker does, so opening a file could reload the page and lose it. (`hmr: false` is not
    // enough: that only stops module updates, and the socket is still used to trigger reloads.)
    ws: mode === 'phone' ? false : undefined,
  },
  // Tests live outside src/, so point Vitest back at the project root.
  test: { root: '.', include: ['test/**/*.test.ts'] },
}));
