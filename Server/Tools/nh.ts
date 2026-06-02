import Config from '../../Config'

export default class nh {
  private endpoint: string = 'https://nhentai.net'

  /**
   * Creates an instance of the nh class.
   * @param args - Optional arguments to configure the class
   * @param args.endpoint - The endpoint for fetching gallery data (default: 'https://nhentai.net')
   */
  constructor(args: { endpoint?: string; imageEndpoint?: string; thumbnailEndpoint?: string; cachePath?: string }) {
    if (!args) return
    if (args.endpoint) this.endpoint = args.endpoint
  }

  /**
   * Fetches gallery data from the API.
   * @param id - The ID of the gallery to fetch
   * @returns A promise that resolves to the gallery data
   */
  public async get(id: string | number): Promise<GalleryData> {
    return await this.fetch(`${this.endpoint}/api/v2/galleries/${id}`)
  }

  /**
   * Obtains the data of a gallery from the API.
   * @param url - The URL of the gallery to fetch data from
   * @returns A promise that resolves to the gallery data
   */
  private async fetch(url: string): Promise<GalleryData> {
    return new Promise((resolve, reject) => {
      fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': `nZip/${Config.version} (+https://github.com/nZip-Team/nZip)`
        }
      })
        .then(async (res) => {
          if (!res.ok) {
            const errorText = await res.text()
            return reject(new Error(`HTTP error! status: ${res.status}, message: ${errorText}`))
          }
          return res.json() as Promise<GalleryData>
        })
        .then((data) => {
          if ((data as any).error) {
            return reject(new Error((data as any).error))
          }
          resolve(data as GalleryData)
        })
        .catch((err) => reject(err))
    })
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

export { nh as nhget }
export type { GalleryData, ImageData, TagData }
