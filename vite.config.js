import { defineConfig } from 'vite';

export default defineConfig({
  base: './',                                   // wzgledne sciezki -> dziala w podkatalogu GH Pages
  optimizeDeps: { exclude: ['manifold-3d'] },   // nie pre-bundluj WASM-owego loadera
  assetsInclude: ['**/*.wasm'],
  resolve: {
    alias: [{ find: /^three\/addons\//, replacement: 'three/examples/jsm/' }],
  },
});
