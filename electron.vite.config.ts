import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      rolldownOptions: {
        input: { main: resolve(import.meta.dirname, 'src/main/main.ts') },
      },
    },
  },
  preload: {
    build: {
      rolldownOptions: {
        input: { preload: resolve(import.meta.dirname, 'src/preload/preload.ts') },
        // Sandboxed preload scripts must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: {
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') },
      },
    },
    // The renderer root is not the project root, so the config path is explicit.
    plugins: [svelte({ configFile: resolve(import.meta.dirname, 'svelte.config.js') })],
  },
});
