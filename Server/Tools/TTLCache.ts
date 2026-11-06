/**
 * Small LRU with a time limit; concurrent misses for one key share a single load.
 * Failed loads are not cached.
 */
export default class TTLCache<V> {
  private entries = new Map<string, { value: V; expiresAt: number }>()
  private loading = new Map<string, Promise<V>>()

  constructor(
    private maxEntries: number,
    private ttlMs: number,
    private onLookup?: (result: 'hit' | 'shared' | 'miss') => void
  ) {}

  get size(): number {
    return this.entries.size
  }

  async get(key: string, load: () => Promise<V>): Promise<V> {
    const entry = this.entries.get(key)
    if (entry) {
      if (entry.expiresAt > Date.now()) {
        // Re-insert, so the Map order stays least recently used first
        this.entries.delete(key)
        this.entries.set(key, entry)
        this.onLookup?.('hit')
        return entry.value
      }
      this.entries.delete(key)
    }

    const pending = this.loading.get(key)
    if (pending) {
      this.onLookup?.('shared')
      return pending
    }

    this.onLookup?.('miss')
    const promise = load()
      .then((value) => {
        this.set(key, value)
        return value
      })
      .finally(() => this.loading.delete(key))
    this.loading.set(key, promise)
    return promise
  }

  private set(key: string, value: V): void {
    this.entries.delete(key)
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  clear(): void {
    this.entries.clear()
  }
}
