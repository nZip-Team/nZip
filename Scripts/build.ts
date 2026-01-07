await Bun.build({
  entrypoints: ['./Main.ts'],
  outdir: './dist',

  format: 'esm',
  target: 'bun',

  packages: 'external'
})
