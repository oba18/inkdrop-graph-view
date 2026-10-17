import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['cjs'],
  sourcemap: true,
  clean: true,
  outExtensions: () => ({ js: '.js' }),
  deps: {
    // Bundled, so the published package needs no install step.
    alwaysBundle: ['d3-force', 'd3-dispatch', 'd3-quadtree', 'd3-timer'],
    // Provided by the host app at runtime.
    neverBundle: ['react', 'react/jsx-runtime', 'react-dom', 'inkdrop', 'event-kit', 'inkdrop-model']
  }
})
