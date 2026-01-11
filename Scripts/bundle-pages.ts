import fs from 'fs'
import path from 'path'

const entrypoints: string[] = []

for (const fileName of fs.readdirSync(path.join(process.cwd(), 'App/Pages'))) {
  entrypoints.push(path.join(process.cwd(), `App/Pages/${fileName}`))
}

await Bun.build({
  entrypoints,
  outdir: './dist/App/Pages',

  format: 'esm',
  target: 'bun',

  packages: 'external'
})
