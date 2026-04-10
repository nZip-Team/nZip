import { get } from 'https'
import fs from 'fs/promises'
import path from 'path'

type versions = 'v1' | 'v2'

export default class nhget {
  private endpoint: string = 'https://nhentai.net/api/v2/galleries/'
  private imageEndpoint: string = 'https://i.nhentai.net/galleries/'
  private thumbnailEndpoint: string = 'https://t.nhentai.net/galleries/'
  private cachePath: string | null = null

  /**
   * Creates an instance of the nhget class.
   * @param args - Optional arguments to configure the class
   * @param args.endpoint - The endpoint for fetching gallery data (default: 'https://nhentai.net/api/v2/galleries/')
   * @param args.imageEndpoint - The endpoint for fetching images (default: 'https://i.nhentai.net/galleries/')
   * @param args.thumbnailEndpoint - The endpoint for fetching thumbnails (default: 'https://t.nhentai.net/galleries/')
   * @param args.cachePath - The path to the cache directory (default: null)
   */
  constructor(args: { endpoint?: string; imageEndpoint?: string; thumbnailEndpoint?: string; cachePath?: string }) {
    if (!args) return
    if (args.endpoint) this.endpoint = args.endpoint
    if (args.imageEndpoint) this.imageEndpoint = args.imageEndpoint
    if (args.thumbnailEndpoint) this.thumbnailEndpoint = args.thumbnailEndpoint
    if (args.cachePath) this.cachePath = args.cachePath
    if (this.cachePath)
      try {
        fs.mkdir(this.cachePath, { recursive: true })
      } catch (error) {}
  }

  /**
   * Fetches gallery data from the API.
   * @param id - The ID of the gallery to fetch
   * @returns A promise that resolves to the gallery data (v2 format)
   */
  public async get(id: string | number): Promise<GalleryDatav2> {
    return await this.fetch(`${this.endpoint}${id}`, id)
  }

  /**
   * Fetches the pages of a gallery.
   * @param id - The ID of the gallery to fetch pages for
   * @returns A promise that resolves to an array of page URLs
   */
  public async getPages(id: string | number): Promise<Array<String>> {
    const data = await this.get(id)
    return data.pages.map(page => `${this.imageEndpoint.replace(/galleries\/$/, '')}${page.path}`)
  }

  /**
   * Fetches the thumbnail pages of a gallery.
   * @param id - The ID of the gallery to fetch thumbnail pages for
   * @returns A promise that resolves to an array of thumbnail page URLs
   */
  public async getPagesThumbnail(id: string | number): Promise<Array<String>> {
    const data = await this.get(id)
    return data.pages.map(page => `${this.thumbnailEndpoint.replace(/galleries\/$/, '')}${page.thumbnail || page.path}`)
  }

  /**
   * Fetches the cover image of a gallery.
   * @param id - The ID of the gallery to fetch the cover for
   * @returns A promise that resolves to the cover image URL
   */
  public async getCover(id: string | number): Promise<String> {
    const data = await this.get(id)
    return `${this.thumbnailEndpoint.replace(/galleries\/$/, '')}${data.cover.path}`
  }

  /**
   * Fetches the thumbnail of the cover image of a gallery.
   * @param id - The ID of the gallery to fetch the cover thumbnail for
   * @returns A promise that resolves to the cover thumbnail URL
   */
  public async getCoverThumbnail(id: string | number): Promise<String> {
    const data = await this.get(id)
    return `${this.thumbnailEndpoint.replace(/galleries\/$/, '')}${data.thumbnail.path}`
  }

  public checkVersion(data: GalleryDatav1 | GalleryDatav2): versions {
    return isGalleryV1(data) ? 'v1' : 'v2'
  }

  /**
   * Obtains the data of a gallery from the API.
   * @param url - The URL of the gallery to fetch data from
   * @param id - The ID of the gallery to fetch data for
   * @returns A promise that resolves to the gallery data (v2 format)
   */
  private async fetch(url: string, id: string | number): Promise<GalleryDatav2> {
    const rangeIndex = Math.floor(Number(id) / 1000)
    const cache = await this.loadCache(rangeIndex)

    if (cache[id]) {
      const cached = cache[id]
      const cachedVersion = isGalleryV1(cached) ? 'v1' : 'v2'
      if (cachedVersion === 'v2') return cached as GalleryDatav2
      // convert v1 to v2, update cache and return
      const converted = convertV1toV2(cached as GalleryDatav1)
      cache[id] = converted
      await this.saveCache(rangeIndex, cache)
      return converted
    }

    return new Promise((resolve, reject) => {
      try {
        get(url, res => {
          let data = ''
          res.on('data', chunk => (data += chunk))
          res.on('end', async () => {
            try {
              const raw = JSON.parse(data) as any
              if (raw.error) return reject(new Error(raw.error))
              if (res.statusCode !== 200) return reject(new Error(`Status code: ${res.statusCode}`))

              let response: GalleryDatav2
              if (isGalleryV1(raw)) {
                response = convertV1toV2(raw as GalleryDatav1)
              } else {
                response = raw as GalleryDatav2
              }

              cache[id] = response
              await this.saveCache(rangeIndex, cache)
              resolve(response)
            } catch (error) {
              reject(error)
            }
          })
        }).on('error', err => reject(err))
      } catch (err) {
        reject(err)
      }
    })
  }

  /**
   * Loads the cache for a specific range index.
   * @param rangeIndex - The range index to load the cache for
   * @returns A promise that resolves to the cache data
   */
  private async loadCache(rangeIndex: number): Promise<Record<string, GalleryData>> {
    if (!this.cachePath) return {}
    const cacheFilePath = path.join(this.cachePath, `${rangeIndex}.json`)
    try {
      const data = await fs.readFile(cacheFilePath, 'utf8')
      return JSON.parse(data)
    } catch {
      return {}
    }
  }

  /**
   * Saves the cache for a specific range index.
   * @param rangeIndex - The range index to save the cache for
   * @param cache - The cache data to save
   */
  private async saveCache(rangeIndex: number, cache: Record<string, GalleryData>): Promise<void> {
    if (!this.cachePath) return
    const cacheFilePath = path.join(this.cachePath, `${rangeIndex}.json`)
    try {
      await fs.writeFile(cacheFilePath, JSON.stringify(cache), 'utf8')
    } catch (error) {
      console.error(`Failed to save cache for range ${rangeIndex}`, error)
    }
  }
}

export interface GalleryDatav1 {
  error?: string
  id: string | number
  media_id: string
  title: {
    english: string
    japanese: string
    pretty: string
  }
  images: {
    pages: Array<ImageData>
    cover: ImageData
    thumbnail: ImageData
  }
  scanlator: string
  upload_date: number
  tags: Array<TagData>
  num_pages: number
  num_favorites: number
}

export function isGalleryV1(data: any): data is GalleryDatav1 {
  return !!(data && data.images && Array.isArray(data.images.pages))
}

export function isGalleryV2(data: any): data is GalleryDatav2 {
  return !!(data && data.pages && Array.isArray(data.pages))
}

export function tToExt(t: ImageData['t']): string {
  switch (t) {
    case 'j':
      return 'jpg'
    case 'p':
      return 'png'
    case 'g':
      return 'gif'
    case 'w':
      return 'webp'
  }
}

export function extToT(ext: string): ImageData['t'] {
  switch (ext.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'j'
    case 'png':
      return 'p'
    case 'gif':
      return 'g'
    case 'webp':
      return 'w'
    default:
      throw new Error(`Unsupported extension: ${ext}`)
  }
}

export function convertV1toV2(v1: GalleryDatav1): GalleryDatav2 {
  const media = String(v1.media_id)
  const pages = v1.images.pages.map((p, i) => ({
    number: i + 1,
    path: `galleries/${media}/${i + 1}.${tToExt(p.t)}`,
    width: p.w,
    height: p.h,
    thumbnail: `galleries/${media}/${i + 1}t.${tToExt(p.t)}`,
    thumbnail_width: Math.min(200, Math.floor(p.w / 4)),
    thumbnail_height: Math.min(320, Math.floor(p.h / 4))
  }))

  const tags: DetailedTag[] = v1.tags.map(tag => ({
    ...tag,
    slug: (tag as any).slug ?? tag.name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '')
  }))

  return {
    error: v1.error,
    id: Number(v1.id),
    media_id: String(v1.media_id),
    title: v1.title,
    cover: { path: `galleries/${media}/cover.${tToExt(v1.images.cover.t)}`, width: v1.images.cover.w, height: v1.images.cover.h },
    thumbnail: { path: `galleries/${media}/thumb.${tToExt(v1.images.thumbnail.t)}`, width: v1.images.thumbnail.w, height: v1.images.thumbnail.h },
    scanlator: v1.scanlator,
    upload_date: v1.upload_date,
    tags,
    num_pages: v1.num_pages,
    num_favorites: v1.num_favorites,
    pages
  }
}

export function convertV2toV1(v2: GalleryDatav2): GalleryDatav1 {
  const parsePagePath = (path: string, width: number, height: number): ImageData => {
    const match = path.match(/\.([^.]+)$/)
    const ext = match ? match[1] : 'jpg'
    return {
      t: extToT(ext),
      w: width,
      h: height
    }
  }

  const pages = v2.pages.map(page => parsePagePath(page.path, page.width, page.height))

  const coverPath = v2.cover.path
  const coverMatch = coverPath.match(/galleries\/([^/]+)\/cover\.([^.]+)$/)
  const coverExt = coverMatch ? coverMatch[2] : 'jpg'

  const thumbnailPath = v2.thumbnail.path
  const thumbMatch = thumbnailPath.match(/galleries\/([^/]+)\/thumb\.([^.]+)$/)
  const thumbExt = thumbMatch ? thumbMatch[2] : 'jpg'

  const tags: TagData[] = v2.tags.map(({ slug, ...tag }) => tag)

  return {
    error: v2.error,
    id: String(v2.id),
    media_id: v2.media_id,
    title: v2.title,
    images: {
      pages,
      cover: {
        t: extToT(coverExt),
        w: v2.cover.width,
        h: v2.cover.height
      },
      thumbnail: {
        t: extToT(thumbExt),
        w: v2.thumbnail.width,
        h: v2.thumbnail.height
      }
    },
    scanlator: v2.scanlator,
    upload_date: v2.upload_date,
    tags,
    num_pages: v2.num_pages,
    num_favorites: v2.num_favorites
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

export interface GalleryDatav2 {
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

type GalleryData = GalleryDatav1 | GalleryDatav2

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

export { nhget }
export type { GalleryData, ImageData, TagData }
