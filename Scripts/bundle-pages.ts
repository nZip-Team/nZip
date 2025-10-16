import { build } from 'tsdown'

build({
  entry: './App/Pages/*.tsx',
  outDir: './dist/App/Pages',

  format: 'esm',
  target: ['esnext'],
  minify: true,

  sourcemap: false,
  clean: false
})
