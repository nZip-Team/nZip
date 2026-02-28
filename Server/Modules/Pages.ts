import path from 'path'
import { existsSync, watch, type FSWatcher } from 'fs'
import type { JSX } from 'hono/jsx/jsx-runtime'

import Log from './Log'
import Frame from './Frame'

import _Home from '../../App/Pages/Home'
import _Download from '../../App/Pages/Download'
import _Error from '../../App/Pages/Error'
import _Terms from '../../App/Pages/Terms'
import _Privacy from '../../App/Pages/Privacy'

type PageModule = (args?: any) => {
  title: string
  description: string
  keywords?: string
  content: JSX.Element
  render: (args: { analytics?: string | null; lang?: string }) => string
}

const RawPageModules = {
  Home: _Home as unknown as PageModule,
  Download: _Download as unknown as PageModule,
  Error: _Error as unknown as PageModule,
  Terms: _Terms as unknown as PageModule,
  Privacy: _Privacy as unknown as PageModule,
} as const satisfies Record<string, PageModule>

type PageName = keyof typeof RawPageModules

const PAGE_NAMES = Object.keys(RawPageModules) as readonly PageName[]

let PageModules: Record<PageName, PageModule> = {
  ...RawPageModules,
}

/**
 * Pages class to manage and load page modules dynamically.
 */
class Pages {
  private cachedPages: Record<PageName, PageModule | null>
  private filePath: string
  private watcher: FSWatcher | null = null
  private reloadCallbacks: Array<(pageName: PageName) => void> = []

  /**
   * Register a callback to be called when a page is reloaded in development mode.
   * @param callback Function called with the reloaded page name
   */
  public onReload(callback: (pageName: PageName) => void): void {
    this.reloadCallbacks.push(callback)
  }

  /**
   * Creates an instance of Pages.
   */
  constructor() {
    this.cachedPages = {} as Record<PageName, PageModule | null>

    PAGE_NAMES.forEach((name) => {
      this.cachedPages[name] = null
    })

    this.filePath = './App'

    this.getPage = this.getPage.bind(this)
    this.page = this.page.bind(this)

    this.loadPages()
    this.setupHotReload()
  }

  /**
   * Loads all page modules from the specified directory.
   * If a page fails to load, it will use the cached version if available.
   */
  private loadPages(): void {
    Log.info('Loading pages...')
    if (process.env['NODE_ENV'] !== 'development') {
      for (const page of PAGE_NAMES) {
        const module = PageModules[page]
        this.cachedPages[page] = module
        this.debug(`Loaded ${page} page`)
      }
      Log.success('All pages loaded successfully')
      this.debug(`Available pages: ${PAGE_NAMES.join(', ')}`)
    } else {
      for (const page of PAGE_NAMES) {
        this.loadPageDev(page)
      }
      Log.success('All pages loaded successfully')
      this.debug(`Available pages: ${PAGE_NAMES.join(', ')}`)
    }
  }

  /**
   * Reload a single page module in development mode using require() so the
   * CJS module cache can be busted. This is the only reliable way to force
   * re-evaluation of a local file in Bun without restarting the process.
   * @param page Page name to reload
   */
  private loadPageDev(page: PageName): void {
    const filePath = this.resolveDevPagePath(page)

    if (!filePath) {
      if (this.cachedPages[page]) {
        this.debug(`Custom ${page} page not found, using cached version`)
      } else {
        this.cachedPages[page] = PageModules[page]
        Log.info(`Using bundled version of ${page} page`)
      }
      return
    }

    try {
      // Bust the require cache for all plausible extensions so the file is
      // re-evaluated fresh on the next require() call.
      for (const ext of ['.tsx', '.ts', '.jsx', '.js', '']) {
        const key = filePath.endsWith(ext) ? filePath : filePath + ext
        if (require.cache[key]) delete require.cache[key]
      }
      const rawmodule = require(filePath)
      const module: PageModule = rawmodule.default || rawmodule
      PageModules[page] = module
      this.cachedPages[page] = module
      this.debug(`Loaded ${page} page`)
    } catch (error) {
      Log.error(`Failed to load ${page} page`, error)
      if (this.cachedPages[page]) {
        Log.info(`Using cached version of ${page} page`)
      } else {
        this.cachedPages[page] = PageModules[page]
        Log.info(`Using bundled version of ${page} page`)
      }
    }
  }

  private resolveDevPagePath(page: PageName): string | null {
    const basePath = path.join(process.cwd(), this.filePath, 'Pages', page)
    for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
      const filePath = basePath + ext
      if (existsSync(filePath)) {
        return filePath
      }
    }
    return null
  }

  /**
   * Sets up a file watcher to enable hot reloading of page modules during development.
   * Watches the Pages directory for changes and reloads the pages when a change is detected.
   */
  private setupHotReload(): void {
    if (process.env['NODE_ENV'] === 'development') {
      const pagesDir = path.join(process.cwd(), `${this.filePath}/Pages`)
      if (existsSync(pagesDir)) {
        this.watcher = watch(pagesDir, (eventType, filename) => {
          if (!filename || eventType !== 'change') return
          // Derive page name from filename (e.g. "Home.tsx" → "Home")
          const pageName = filename.replace(/\.[^.]+$/, '') as PageName
          if (!PAGE_NAMES.includes(pageName)) return
          Log.info(`Page file changed: ${filename} - reloading ${pageName}...`)
          this.loadPageDev(pageName)
          Log.success(`Page ${pageName} reloaded`)
          for (const cb of this.reloadCallbacks) {
            try { cb(pageName) } catch { /* ignore callback errors */ }
          }
        })
        Log.info('Hot reloading enabled for page files')
      }
    }
  }

  /**
   * Retrieves a page module by its name.
   * @param pageName The name of the page to retrieve.
   * @returns The requested page module.
   */
  public getPage(pageName: PageName): PageModule {
    return this.addRenderer(this.cachedPages[pageName] ?? PageModules[pageName])
  }

  /**
   * Renders a page by its name with optional arguments.
   * @param pageName The name of the page to render.
   * @param args Optional arguments to pass to the page module.
   * @returns The page object with title, description, keywords, content, and render method.
   */
  public page(pageName: PageName, args?: any): ReturnType<PageModule> {
    return this.addRenderer(this.cachedPages[pageName] ?? PageModules[pageName])(args)
  }

  private addRenderer(pageModule: PageModule): PageModule {
    return (args?: any) => {
      const page = pageModule(args)
      return {
        ...page,
        render: (renderArgs: { analytics?: string | null; lang?: string }) => {
          return Frame(page, renderArgs)
        }
      }
    }
  }

  /**
   * Returns a list of available page names.
   * @returns An array of page names.
   */
  public getAvailablePages(): readonly PageName[] {
    return PAGE_NAMES
  }

  /**
   * Reloads all page modules, useful for development to apply changes without restarting the server.
   */
  public reloadPages(): void {
    this.loadPages()
  }

  /**
   * Shuts down the page watcher if it exists.
   * This is useful to clean up resources when the server is shutting down.
   */
  public shutdown(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
      Log.info('Page watcher closed')
    }
  }

  /**
   * Debugging utility to log messages only in development mode.
   * @param message The message(s) to log.
   */
  private debug(...message: any[]): void {
    if (process.env['NODE_ENV'] === 'development') {
      Log.debug(...message)
    }
  }
}

export default new Pages()
export type { PageName, PageModule }
