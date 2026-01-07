import path from 'path'
import { existsSync, watch, type FSWatcher } from 'fs'
import type { JSX } from 'hono/jsx/jsx-runtime'

import Log from '@icebrick/log'

import Frame from './Frame'

const PAGE_NAMES = ['Home', 'Download', 'Error', 'Terms', 'Privacy'] as const

type PageName = (typeof PAGE_NAMES)[number]

type PageModule = (args?: any) => {
  title: string
  description: string
  keywords?: string
  content: JSX.Element
  render: (args: { analytics?: string | null }) => string
}

/**
 * Pages class to manage and load page modules dynamically.
 */
class Pages {
  private pageModules: Record<PageName, PageModule>
  private cachedPages: Record<PageName, PageModule | null>
  private filePath: string
  private watcher: FSWatcher | null = null

  /**
   * Creates an instance of Pages.
   */
  constructor() {
    this.pageModules = {} as Record<PageName, PageModule>
    this.cachedPages = {} as Record<PageName, PageModule | null>

    PAGE_NAMES.forEach((name) => {
      this.pageModules[name] = null as unknown as PageModule
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
    if (process.env['NODE_ENV'] === 'development') {
      Object.keys(require.cache).forEach((key) => {
        if (key.includes('Pages')) {
          delete require.cache[key]
        }
      })
    }

    Log.info('Loading pages...')
    for (const page of PAGE_NAMES) {
      try {
        const filePath = path.join(process.cwd(), this.filePath, 'Pages', `${page}`)
        const rawmodule = require(filePath)
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

  /**
   * Sets up a file watcher to enable hot reloading of page modules during development.
   * Watches the Pages directory for changes and reloads the pages when a change is detected.
   */
  private setupHotReload(): void {
    if (process.env['NODE_ENV'] === 'development') {
      const pagesDir = path.join(process.cwd(), `${this.filePath}/Pages`)
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

  /**
   * Retrieves a page module by its name.
   * @param pageName The name of the page to retrieve.
   * @returns The requested page module.
   */
  public getPage(pageName: PageName): PageModule {
    return this.addRenderer(this.pageModules[pageName])
  }

  /**
   * Renders a page by its name with optional arguments.
   * @param pageName The name of the page to render.
   * @param args Optional arguments to pass to the page module.
   * @returns The page object with title, description, keywords, content, and render method.
   */
  public page(pageName: PageName, args?: any): ReturnType<PageModule> {
    return this.addRenderer(this.pageModules[pageName])(args)
  }

  private addRenderer(pageModule: PageModule): PageModule {
    return (args?: any) => {
      const page = pageModule(args)
      return {
        ...page,
        render: (renderArgs: { analytics?: string | null }) => {
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
