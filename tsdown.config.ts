import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./Main.ts'],
  outDir: './dist',

  format: 'esm',
  minify: false,

  sourcemap: false,
  clean: false
})
