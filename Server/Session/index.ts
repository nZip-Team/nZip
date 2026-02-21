import SQLiteSessionStore from './SQLiteSessionStore'
import RedisSessionStore from './RedisSessionStore'

export interface SharedSessionData {
  id: string
  hash: string
  downloadCompleted: boolean
  isDownloading: boolean
  downloadingBy?: string
  filename?: string
  downloadLink?: string
  lastDownloadStatus?: string
  lastPackStatus?: string
  lastLinkStatus?: string
  isAborting: boolean
  createdAt: number
  lastActivityAt: number
}

/**
 * Session store interface that all implementations must satisfy
 */
export interface ISessionStore {
  getOrCreate(id: string, hash: string): Promise<SharedSessionData>
  get(hash: string): SharedSessionData | null | Promise<SharedSessionData | null>
  update(hash: string, data: Partial<SharedSessionData>): Promise<void>
  touch(hash: string): Promise<void>
  delete(hash: string): Promise<void>
  exists(hash: string): Promise<boolean>
  tryAcquireLock(hash: string, processID: string): Promise<boolean>
  refreshLock(hash: string, processID: string): Promise<boolean>
  releaseLock(hash: string, processID: string): Promise<void>
  close(): Promise<void>
  getAll(): SharedSessionData[] | Promise<SharedSessionData[]>
}

/**
 * Create a session store based on environment configuration
 * @param storeType Type of store: 'sqlite' or 'redis'
 * @returns Session store instance
 */
export function createSessionStore(storeType: string): ISessionStore {
  switch (storeType) {
    case 'redis':
      return new RedisSessionStore()
    case 'sqlite':
    default:
      return new SQLiteSessionStore()
  }
}

export type SessionStore = ISessionStore
