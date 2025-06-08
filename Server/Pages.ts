import path from 'path'
import { existsSync, watch, type FSWatcher } from 'fs'

import Log from '@icebrick/log'

import type { Page as PageModule } from './Types'

const PAGE_NAMES = ['Home', 'Download', 'Error', 'Terms', 'Privacy'] as const

type PageName = typeof PAGE_NAMES[number]

class Pages {
  private pageModules: Record<PageName, PageModule>
  private cachedPages: Record<PageName, PageModule | null>
  private filePath: string
  private watcher: FSWatcher | null = null

  constructor() {
    this.pageModules = {} as Record<PageName, PageModule>
    this.cachedPages = {} as Record<PageName, PageModule | null>

    PAGE_NAMES.forEach(name => {
      this.pageModules[name] = null as unknown as PageModule
      this.cachedPages[name] = null
    })

    this.filePath = './App'
    if (!existsSync(path.join(__dirname, this.filePath))) this.filePath = '../App'

    this.loadPages()
    this.setupHotReload()
  }

  private loadPages(): void {
    if (process.env['NODE_ENV'] === 'development') {
      Object.keys(require.cache).forEach(key => {
        if (key.includes('Pages')) {
          delete require.cache[key]
        }
      })
    }

    Log.info('Loading pages...')
    for (const page of PAGE_NAMES) {
      try {
        const rawmodule = require(`${this.filePath}/Pages/${page}`)
        const module = rawmodule.default || rawmodule
        this.pageModules[page] = module
        this.cachedPages[page] = module
        this.debug(`Loaded ${page} page`)
      } catch (error) {
        Log.error(`Failed to load ${page} page`, error)
        if (this.cachedPages[page]) {
          this.pageModules[page] = this.cachedPages[page] as PageModule
          Log.info(`Using cached version of ${page} page`)
        }
      }
    }

    Log.success('All pages loaded successfully')
    this.debug(`Available pages: ${PAGE_NAMES.join(', ')}`)
  }

  private setupHotReload(): void {
    if (process.env['NODE_ENV'] === 'development') {
      const pagesDir = path.join(__dirname, `${this.filePath}/Pages`)
      if (existsSync(pagesDir)) {
        this.watcher = watch(pagesDir, (eventType, filename) => {
          if (filename && eventType === 'change') {
            Log.info(`Page file changed: ${filename} - reloading...`)
            try {
              this.loadPages()
              Log.success('Pages reloaded successfully')
            } catch (error) {
              Log.error('Failed to reload pages:', error)
            }
          }
        })
        Log.info('Hot reloading enabled for page files')
      }
    }
  }

  public getPage(pageName: PageName): PageModule {
    if (!this.pageModules[pageName]) {
      Log.warn(`Requested page ${pageName} not found, returning Error page`)
      return this.pageModules.Error || ({} as PageModule)
    }
    return this.pageModules[pageName]
  }

  public getAvailablePages(): readonly PageName[] {
    return PAGE_NAMES
  }

  public reloadPages(): void {
    this.loadPages()
  }

  public shutdown(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
      Log.info('Page watcher closed')
    }
  }

  private debug(...message: any[]): void {
    if (process.env['NODE_ENV'] === 'development') {
      Log.debug(...message)
    }
  }
}

export default new Pages()
export type { PageName }
