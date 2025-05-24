import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./Main.ts'],
  format: 'cjs',
  minify: true,
  sourcemap: true,
  clean: false,
  outDir: './dist'
})
