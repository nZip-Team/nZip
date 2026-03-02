import fs, { existsSync, watch, type FSWatcher } from 'fs'
import path, { win32, posix } from 'path'

import Log from './Log'

type ScriptManifest = Record<string, string>

class Scripts {
  private manifest: ScriptManifest = {}
  private filePath = './App/Scripts/manifest.json'
  private watcher: FSWatcher | null = null
  private sourceWatcher: FSWatcher | null = null
  private sourceWatcherTimeout: NodeJS.Timeout | null = null
  private bundling = false
  private pendingBundle = false

  constructor() {
    this.loadManifest()
    this.setupHotReload()
  }

  private loadManifest(): void {
    const manifestPath = path.join(process.cwd(), this.filePath)

    if (!existsSync(manifestPath)) {
      this.manifest = {}
      return
    }

    try {
      this.manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ScriptManifest
    } catch (error) {
      Log.error('Failed to load script manifest', error)
      this.manifest = {}
    }
  }

  private createManifestFromDir(dirPath: string): ScriptManifest {
    const manifest: ScriptManifest = {}

    if (!existsSync(dirPath)) {
      return manifest
    }

    for (const fileName of fs.readdirSync(dirPath)) {
      if (!fileName.endsWith('.js')) continue

      const baseName = fileName.replace(/\.js$/, '')
      if (baseName === 'manifest') continue

      const scriptName = baseName.replace(/-[a-zA-Z0-9]+$/, '')
      manifest[scriptName] = fileName
    }

    return manifest
  }

  private setupHotReload(): void {
    if (process.env['NODE_ENV'] !== 'development') return

    const manifestPath = path.join(process.cwd(), this.filePath)
    const manifestDir = path.dirname(manifestPath)

    if (!existsSync(manifestDir)) return

    this.watcher = watch(manifestDir, (eventType, filename) => {
      if (!filename || filename !== 'manifest.json') return
      if (eventType !== 'change' && eventType !== 'rename') return

      this.loadManifest()
      Log.info('Script manifest reloaded')
    })

    this.watcher.unref?.()
  }

  public getScript(scriptName: string): string {
    const fileName = this.manifest[scriptName] || `${scriptName}.js`
    return `/Scripts/${fileName}`
  }

  public async bundle(): Promise<void> {
    if (this.bundling) {
      this.pendingBundle = true
      return
    }

    this.bundling = true

    try {
      do {
        this.pendingBundle = false
        await this.bundleOnce()
      } while (this.pendingBundle)
    } finally {
      this.bundling = false
    }
  }

  private async bundleOnce(): Promise<void> {
    const sourceDir = path.join(process.cwd(), './Server/Scripts')
    if (!existsSync(sourceDir)) return

    Log.info('Bundling Scripts...')

    const outputDir = path.join(process.cwd(), './App/Scripts')
    if (existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true })
    fs.mkdirSync(outputDir, { recursive: true })

    const scripts: string[] = []
    for (const fileName of fs.readdirSync(sourceDir)) {
      if (!fileName.endsWith('.ts') && !fileName.endsWith('.mjs')) continue
      scripts.push(path.join(process.cwd(), `Server/Scripts/${fileName}`).split(win32.sep).join(posix.sep))
    }

    await Bun.build({
      entrypoints: scripts,
      outdir: './App/Scripts',
      naming: '[name]-[hash].[ext]',

      format: 'esm',
      target: 'browser',
      minify: true,
    })

    this.writeManifest()
    this.reloadManifest()

    Log.success('Bundled Scripts')
  }

  public writeManifest(): void {
    const scriptsDir = path.join(process.cwd(), './App/Scripts')
    const manifestPath = path.join(process.cwd(), this.filePath)

    this.manifest = this.createManifestFromDir(scriptsDir)
    fs.writeFileSync(manifestPath, JSON.stringify(this.manifest, null, 2), 'utf-8')
  }

  public reloadManifest(): void {
    this.loadManifest()
  }

  public watchSource(): void {
    if (process.env['NODE_ENV'] !== 'development') return

    const sourceDir = path.join(process.cwd(), 'Server', 'Scripts')
    if (!existsSync(sourceDir)) return

    this.stopWatchingSource()

    this.sourceWatcher = watch(sourceDir, { recursive: true }, () => {
      if (this.sourceWatcherTimeout) {
        clearTimeout(this.sourceWatcherTimeout)
      }

      this.sourceWatcherTimeout = setTimeout(() => {
        this.bundle().catch((error) => Log.error('Failed to bundle scripts', error))
      }, 3000)
    })

    this.sourceWatcher.unref?.()
  }

  public stopWatchingSource(): void {
    if (this.sourceWatcherTimeout) {
      clearTimeout(this.sourceWatcherTimeout)
      this.sourceWatcherTimeout = null
    }

    if (this.sourceWatcher) {
      this.sourceWatcher.close()
      this.sourceWatcher = null
    }
  }

  public shutdown(): void {
    this.stopWatchingSource()

    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }
}

export default new Scripts()
