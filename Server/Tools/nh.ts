import Config from '../../Config'

import TTLCache from './TTLCache'
import { isGalleryID } from './GalleryID'
import { metadataCache } from './Metrics'

const REQUEST_TIMEOUT_MS = 15000
// Popular galleries and the first search pages are asked for many times a minute
const CACHE_TTL_MS = 60000
const CACHE_ENTRIES = 500

export default class nh {
  private endpoint: string
  private galleries = new TTLCache<GalleryData>(CACHE_ENTRIES, CACHE_TTL_MS, (result) => metadataCache.inc({ kind: 'gallery', result }))
  private searches = new TTLCache<SearchData>(CACHE_ENTRIES, CACHE_TTL_MS, (result) => metadataCache.inc({ kind: 'search', result }))

  /**
   * @param endpoint - Base URL of the gallery API
   */
  constructor(endpoint: string) {
    this.endpoint = endpoint.replace(/\/+$/, '')
  }

  /**
   * Fetches gallery data from the API.
   * @param id - The ID of the gallery to fetch
   * @returns A promise that resolves to the gallery data
   */
  public async get(id: string | number): Promise<GalleryData> {
    // Interpolated into the API path, so nothing but digits may get through
    if (!isGalleryID(id)) throw new Error(`Invalid gallery ID: ${JSON.stringify(String(id))}`)
    return this.galleries.get(String(id), () => this.fetch<GalleryData>(`${this.endpoint}/api/v2/galleries/${id}`))
  }

  /**
   * Searches galleries with the nhentai query syntax.
   * @param query - The search query
   * @param page - The page number, starting at 1
   * @param sort - The sort order
   * @returns A promise that resolves to one page of results
   */
  public async search(query: string, page: number = 1, sort: SearchSort = 'date'): Promise<SearchData> {
    const params = new URLSearchParams({ query, page: String(page) })
    if (sort !== 'date') params.set('sort', sort)
    return this.searches.get(params.toString(), () => this.fetch<SearchData>(`${this.endpoint}/api/v2/search?${params}`))
  }

  private async fetch<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': `nZip/${Config.version} (+https://github.com/nZip-Team/nZip)`
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      throw new Error(`HTTP error! status: ${res.status}, message: ${errorText.slice(0, 200)}`)
    }

    const data = (await res.json()) as T & { error?: unknown }
    if (data && typeof data === 'object' && data.error) {
      throw new Error(String(data.error))
    }
    return data
  }
}

interface TitleData {
  english: string
  japanese: string
  pretty: string
}

interface ImageFile {
  path: string
  width: number
  height: number
}

interface Page {
  number: number
  path: string
  width: number
  height: number
  thumbnail?: string
  thumbnail_width?: number
  thumbnail_height?: number
}

interface Poster {
  id: number
  username: string
  slug?: string
  avatar_url?: string
  is_superuser?: boolean
  is_staff?: boolean
}

interface Comment {
  id: number
  gallery_id: number
  poster: Poster
  post_date: number
  body: string
}

interface Related {
  id: number
  media_id: string
  thumbnail?: string
  thumbnail_width?: number
  thumbnail_height?: number
  english_title?: string
  japanese_title?: string
  tag_ids?: number[]
}

interface DetailedTag extends TagData {
  slug?: string
}

interface GalleryData {
  error?: string
  id: number
  media_id: string
  title: TitleData
  cover: ImageFile
  thumbnail: ImageFile
  scanlator: string
  upload_date: number
  tags: DetailedTag[]
  num_pages: number
  num_favorites: number
  pages: Page[]
  comments?: Comment[]
  related?: Related[]
  is_favorited?: boolean
}

type SearchSort = 'date' | 'popular' | 'popular-today' | 'popular-week' | 'popular-month'

interface SearchResult {
  id: number
  media_id: string
  english_title: string | null
  japanese_title: string | null
  thumbnail: string
  thumbnail_width: number
  thumbnail_height: number
  num_pages: number
  num_favorites: number
  tag_ids: number[]
  blacklisted: boolean
}

interface SearchData {
  result: SearchResult[]
  num_pages: number
  per_page: number
  total: number
}

interface ImageData {
  t: 'j' | 'p' | 'g' | 'w'
  w: number
  h: number
}

interface TagData {
  id: string | number
  type: string
  name: string
  url: string
  count: number
}

export type { GalleryData, ImageData, TagData, SearchData, SearchResult, SearchSort }
