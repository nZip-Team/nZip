import { build } from 'tsdown'
import path, { win32, posix } from 'path'
import fs from 'fs'

import Log from '@icebrick/log'

/**
 * Bundle scripts
 */
export default async (): Promise<void> => {
  if (!fs.existsSync(path.join(__dirname, './Scripts'))) return

  Log.info('Bundling Scripts...')

  if (fs.existsSync(path.join(__dirname, '../App/Scripts'))) fs.rmSync(path.join(__dirname, '../App/Scripts'), { recursive: true })
  fs.mkdirSync(path.join(__dirname, '../App/Scripts'), { recursive: true })

  let scripts: string[] = []

  for (const fileName of fs.readdirSync(path.resolve(__dirname, './Scripts'))) {
    if (!fileName.endsWith('.ts') && !fileName.endsWith('.mjs')) continue
    scripts.push(path.resolve(__dirname, `./Scripts/${fileName}`).split(win32.sep).join(posix.sep))
  }

  await build({
    entry: scripts,
    outDir: path.join(__dirname, '../App/Scripts'),

    format: 'esm',
    target: 'browser',
    minify: true,

    silent: true,
    skipNodeModulesBundle: true,
    external: 'terser',
    noExternal: [/(.*)/],
    sourcemap: false,
    clean: false
  })

  Log.success('Bundled Scripts')
}
