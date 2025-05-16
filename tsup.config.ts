import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['./Main.ts'],
  minify: true,
  sourcemap: true,
  clean: true,
  outDir: './dist'
})
