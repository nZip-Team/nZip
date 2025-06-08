import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./Main.ts'],
  outDir: './dist',

  format: 'cjs',
  minify: false,

  sourcemap: false,
  clean: false,
})
