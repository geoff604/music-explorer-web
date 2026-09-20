import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the built site works from any sub-path (GitHub Pages, gpeters.com/music/).
  base: './',
  build: { target: 'es2022' },
  test: { include: ['test/**/*.test.ts'] },
});
