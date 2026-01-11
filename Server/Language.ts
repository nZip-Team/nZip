import fs from 'fs'
import path from 'path'
import { existsSync, watch, type FSWatcher } from 'fs'

import Log from '@icebrick/log'

export interface LanguageData {
  language: string
  symbol: string
  home: Record<string, string>
  download: Record<string, string>
  error: Record<string, string>
  terms: Record<string, string>
  privacy: Record<string, string>
}

/**
 * Languages class to manage and load language files dynamically.
 */
class Languages {
  private languageModules: Record<string, LanguageData>
  private cachedLanguages: Record<string, LanguageData | null>
  private filePath: string
  private watcher: FSWatcher | null = null

  /**
   * Creates an instance of Languages.
   */
  constructor() {
    this.languageModules = {}
    this.cachedLanguages = {}

    this.filePath = './App/Languages'

    this.getLanguage = this.getLanguage.bind(this)
    this.getLanguageFromCookie = this.getLanguageFromCookie.bind(this)

    this.loadLanguages()
    this.setupHotReload()
  }

  /**
   * Loads all language files from the specified directory.
   * If a language fails to load, it will use the cached version if available.
   */
  private loadLanguages(): void {
    Log.info('Loading languages...')

    const langDir = path.join(process.cwd(), this.filePath)
    if (!existsSync(langDir)) {
      Log.warn('Languages directory not found')
      return
    }

    const files = fs.readdirSync(langDir).filter(file => file.endsWith('.json'))

    for (const file of files) {
      const langCode = file.replace('.json', '')
      try {
        const langPath = path.join(langDir, file)
        const data = JSON.parse(fs.readFileSync(langPath, 'utf-8'))
        this.languageModules[langCode] = data
        this.cachedLanguages[langCode] = data
        this.debug(`Loaded ${langCode} language`)
      } catch (error) {
        Log.error(`Failed to load ${langCode} language`, error)
        if (this.cachedLanguages[langCode]) {
          this.languageModules[langCode] = this.cachedLanguages[langCode] as LanguageData
          Log.info(`Using cached version of ${langCode} language`)
        }
      }
    }

    Log.success('All languages loaded successfully')
    this.debug(`Available languages: ${Object.keys(this.languageModules).join(', ')}`)
  }

  /**
   * Sets up a file watcher to enable hot reloading of language files during development.
   * Watches the Languages directory for changes and reloads the languages when a change is detected.
   */
  private setupHotReload(): void {
    if (process.env['NODE_ENV'] === 'development') {
      const langDir = path.join(process.cwd(), this.filePath)
      if (existsSync(langDir)) {
        this.watcher = watch(langDir, (eventType, filename) => {
          if (filename && filename.endsWith('.json') && (eventType === 'change' || eventType === 'rename')) {
            Log.info(`Language file changed: ${filename} - reloading...`)
            try {
              this.loadLanguages()
              Log.success('Languages reloaded successfully')
            } catch (error) {
              Log.error('Failed to reload languages:', error)
            }
          }
        })
        Log.info('Hot reloading enabled for language files')
      }
    }
  }

  /**
   * Retrieves a language by its code.
   * @param langCode The language code to retrieve (e.g., 'en_us', 'zh_tw').
   * @returns The requested language data or null if not found.
   */
  public getLanguage(langCode: string): LanguageData | null {
    return this.languageModules[langCode] || null
  }

  /**
   * Translate a key within a specific page to the specified language
   * @param langCode The language code to use for translation
   * @param page The page name (home, download, error, terms, privacy)
   * @param key The translation key (English text)
   * @returns The translated text, or the key itself if not found
   */
  public translate(langCode: string, page: string, key: string): string {
    const lang = this.getLanguage(langCode)
    if (!lang) return key
    const pageData = lang[page as keyof LanguageData] as Record<string, string> | undefined
    if (pageData && typeof pageData === 'object' && key in pageData) {
      return pageData[key]
    }
    return key
  }

  /**
   * Get language from cookie header
   * @param cookieHeader Cookie header string
   * @returns Language code (defaults to 'en_us')
   */
  public getLanguageFromCookie(cookieHeader: string | undefined): string {
    if (!cookieHeader) return 'en_us'

    const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
      const [key, value] = cookie.trim().split('=')
      acc[key] = value
      return acc
    }, {} as Record<string, string>)

    return cookies['language'] || 'en_us'
  }

  /**
   * Get language from Accept-Language header
   * @param acceptLanguageHeader Accept-Language header string
   * @returns Language code (defaults to 'en_us')
   */
  public getLanguageFromHeader(acceptLanguageHeader: string | undefined): string {
    if (!acceptLanguageHeader) return 'en_us'

    const languages = acceptLanguageHeader.split(',').map(lang => 
      lang.split(';')[0].trim().toLowerCase().replace('-', '_')
    )

    for (const lang of languages) {
      if (this.languageModules[lang]) {
        return lang
      }
      const baseLang = lang.split('_')[0]
      if (this.languageModules[baseLang]) {
        return baseLang
      }
    }

    return 'en_us'
  }

  /**
   * Returns a list of available language codes with their metadata.
   * @returns An array of language objects with code, name, and symbol.
   */
  public getAvailableLanguages(): Array<{ code: string; name: string; symbol: string }> {
    return Object.entries(this.languageModules).map(([code, data]) => ({
      code,
      name: data.language,
      symbol: data.symbol
    }))
  }

  /**
   * Reloads all language files, useful for development to apply changes without restarting the server.
   */
  public reloadLanguages(): void {
    this.loadLanguages()
  }

  /**
   * Shuts down the language watcher if it exists.
   * This is useful to clean up resources when the server is shutting down.
   */
  public shutdown(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
      Log.info('Language watcher closed')
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

export default new Languages()
export type { LanguageData as LanguageModule }
