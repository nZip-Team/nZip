import { build } from 'tsdown'

build({
  entry: './App/Pages/*.ts',
  outDir: './dist/App/Pages',

  format: 'cjs',
  target: ['esnext'],
  minify: true,

  sourcemap: false,
  clean: false
})
