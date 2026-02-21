import { RedisClient } from 'bun'

import Log from '../Modules/Log'

import type { SessionStore, SharedSessionData } from '.'

/**
 * Redis-based session store
 */
export default class RedisSessionStore implements SessionStore {
  private client: RedisClient
  private cleanupInterval: Timer | null = null
  private keyPrefix = 'nzip:session:'
  private staleLockMs = 5 * 60 * 1000

  constructor() {
    this.client = new RedisClient()
    this.startCleanupJob()
  }

  /**
   * Get or create a session
   */
  async getOrCreate(id: string, hash: string): Promise<SharedSessionData> {
    const existing = await this.get(hash)
    if (existing) {
      await this.touch(hash)
      return existing
    }

    const now = Date.now()
    const session: SharedSessionData = {
      id,
      hash,
      downloadCompleted: false,
      isDownloading: false,
      isAborting: false,
      createdAt: now,
      lastActivityAt: now
    }

    await this.client.setex(`${this.keyPrefix}${hash}`, 300, JSON.stringify(session))
    return session
  }

  /**
   * Get a session by hash
   */
  async get(hash: string): Promise<SharedSessionData | null> {
    const data = await this.client.get(`${this.keyPrefix}${hash}`)
    if (!data) return null

    return JSON.parse(data) as SharedSessionData
  }

  /**
   * Update session data
   */
  async update(hash: string, data: Partial<SharedSessionData>): Promise<void> {
    const session = await this.get(hash)
    if (!session) return

    const updated = {
      ...session,
      ...data,
      lastActivityAt: Date.now()
    }

    await this.client.setex(`${this.keyPrefix}${hash}`, 300, JSON.stringify(updated))
  }

  /**
   * Update last activity timestamp
   */
  async touch(hash: string): Promise<void> {
    const session = await this.get(hash)
    if (!session) return

    session.lastActivityAt = Date.now()
    await this.client.setex(`${this.keyPrefix}${hash}`, 300, JSON.stringify(session))
  }

  /**
   * Delete a session
   */
  async delete(hash: string): Promise<void> {
    await this.client.del(`${this.keyPrefix}${hash}`)
  }

  /**
   * Check if a session exists and is active
   */
  async exists(hash: string): Promise<boolean> {
    const result = await this.client.exists(`${this.keyPrefix}${hash}`)
    return result
  }

  /**
   * Try to acquire a download lock for a session using Redis SETNX
   * @param hash Session hash
   * @param processID Unique identifier for this process
   * @returns true if lock was acquired, false if another process already has it
   */
  async tryAcquireLock(hash: string, processID: string): Promise<boolean> {
    try {
      const session = await this.get(hash)
      if (!session) return false

      const lockKey = `${this.keyPrefix}${hash}:lock`
      const now = Date.now()

      if (session.downloadCompleted) {
        return false
      }

      if (session.isDownloading) {
        const lockExists = await this.client.exists(lockKey)
        const isStale = now - session.lastActivityAt > this.staleLockMs
        if (lockExists || !isStale) {
          return false
        }
      }

      const acquired = await this.client.setnx(lockKey, processID)

      if (acquired) {
        await this.client.expire(lockKey, 300)
        session.isDownloading = true
        session.downloadingBy = processID
        session.lastActivityAt = now

        await this.client.setex(`${this.keyPrefix}${hash}`, 300, JSON.stringify(session))
        return true
      }

      return false
    } catch (error) {
      Log.error(`Error acquiring lock for ${hash}: ${error}`)
      return false
    }
  }

  /**
   * Release a download lock for a session
   * @param hash Session hash
   * @param processID Unique identifier for this process
   */
  async releaseLock(hash: string, processID: string): Promise<void> {
    try {
      const lockKey = `${this.keyPrefix}${hash}:lock`
      const currentLock = await this.client.get(lockKey)

      if (currentLock === processID) {
        const session = await this.get(hash)
        if (session && session.downloadingBy === processID) {
          session.isDownloading = false
          session.downloadingBy = undefined
          await this.client.setex(`${this.keyPrefix}${hash}`, 300, JSON.stringify(session))
        }

        await this.client.del(lockKey)
      }
    } catch (error) {
      Log.error(`Error releasing lock for ${hash}: ${error}`)
    }
  }

  /**
   * Refresh an active lock and session TTL
   */
  async refreshLock(hash: string, processID: string): Promise<boolean> {
    try {
      const lockKey = `${this.keyPrefix}${hash}:lock`
      const currentLock = await this.client.get(lockKey)
      if (currentLock !== processID) {
        return false
      }

      await this.client.expire(lockKey, 300)

      const session = await this.get(hash)
      if (!session) return false
      if (session.downloadingBy !== processID) return false

      session.lastActivityAt = Date.now()
      await this.client.setex(`${this.keyPrefix}${hash}`, 300, JSON.stringify(session))
      return true
    } catch (error) {
      Log.warn(`Error refreshing lock for ${hash}: ${error}`)
      return false
    }
  }

  /**
   * Clean up old sessions (handled by Redis TTL, but we scan for logging)
   */
  private async cleanup(): Promise<void> {
    try {
      const keys = await this.client.keys(`${this.keyPrefix}*`)
      if (keys && keys.length > 0) {
        const sessionKeys = keys.filter(key => !key.endsWith(':lock'))
        if (sessionKeys.length > 0) {
          // Log.info(`RedisSessionStore: ${sessionKeys.length} active session(s)`)
        }
      }
    } catch (error) {
      Log.warn(`RedisSessionStore cleanup error: ${error}`)
    }
  }

  /**
   * Start periodic cleanup job
   */
  private startCleanupJob(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup()
    }, 60000)
  }

  /**
   * Stop cleanup job and release all active locks
   */
  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }

    try {
      const lockKeys = await this.client.keys(`${this.keyPrefix}*:lock`)
      if (!lockKeys || lockKeys.length === 0) return
      for (const lockKey of lockKeys) {
        const hash = lockKey.slice(this.keyPrefix.length, -':lock'.length)
        const session = await this.get(hash)
        if (session?.isDownloading) {
          session.isDownloading = false
          session.downloadingBy = undefined
          await this.client.setex(`${this.keyPrefix}${hash}`, 300, JSON.stringify(session))
        }
        await this.client.del(lockKey)
      }
    } catch (error) {
      Log.warn(`RedisSessionStore: Error releasing locks on close: ${error}`)
    }
  }

  /**
   * Get all active sessions (for debugging)
   */
  async getAll(): Promise<SharedSessionData[]> {
    const keys = await this.client.keys(`${this.keyPrefix}*`)
    if (!keys || keys.length === 0) return []

    const sessions: SharedSessionData[] = []
    for (const key of keys) {
      if (key.endsWith(':lock')) continue

      const data = await this.client.get(key)
      if (data) {
        try {
          sessions.push(JSON.parse(data))
        } catch (error) {
          Log.warn(`Failed to parse session data for key ${key}: ${error}`)
        }
      }
    }
    return sessions
  }
}
