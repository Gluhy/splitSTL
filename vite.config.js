import { defineConfig } from 'vite';

export default defineConfig({
  base: './',                                   // relative paths -> works in a GH Pages subdirectory
  optimizeDeps: { exclude: ['manifold-3d'] },   // don't pre-bundle the WASM loader
  assetsInclude: ['**/*.wasm'],
  resolve: {
    alias: [{ find: /^three\/addons\//, replacement: 'three/examples/jsm/' }],
  },
});
