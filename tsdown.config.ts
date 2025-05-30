import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./Main.ts'],
  outDir: './dist',

  format: 'cjs',
  minify: true,

  sourcemap: false,
  clean: false,
})
