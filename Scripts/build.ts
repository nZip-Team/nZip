await Bun.build({
  entrypoints: ['./Main.ts', './Cluster.ts'],
  outdir: './dist',

  format: 'esm',
  target: 'bun',

  packages: 'external'
})
