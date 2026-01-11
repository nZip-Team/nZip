import path, { win32, posix } from 'path'
import fs from 'fs'

import Log from '@icebrick/log'

/**
 * Bundle scripts
 */
export default async (): Promise<void> => {
  if (!fs.existsSync(path.join(process.cwd(), './Server/Scripts'))) return

  Log.info('Bundling Scripts...')

  if (fs.existsSync(path.join(process.cwd(), './App/Scripts'))) fs.rmSync(path.join(process.cwd(), './App/Scripts'), { recursive: true })
  fs.mkdirSync(path.join(process.cwd(), './App/Scripts'), { recursive: true })

  let scripts: string[] = []

  for (const fileName of fs.readdirSync(path.join(process.cwd(), 'Server/Scripts'))) {
    if (!fileName.endsWith('.ts') && !fileName.endsWith('.mjs')) continue
    scripts.push(path.join(process.cwd(), `Server/Scripts/${fileName}`).split(win32.sep).join(posix.sep))
  }

  await Bun.build({
    entrypoints: scripts,
    outdir: './App/Scripts',

    format: 'esm',
    target: 'browser',
    minify: true,
  })

  Log.success('Bundled Scripts')
}
