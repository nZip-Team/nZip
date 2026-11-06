/**
 * Prometheus text exposition, without a client library.
 * Counters and histograms are per process; gauges are read when scraped.
 */

type Labels = Record<string, string>

function labelKey(labels: Labels): string {
  const names = Object.keys(labels).sort()
  if (names.length === 0) return ''
  return `{${names.map((name) => `${name}="${escapeLabel(labels[name] ?? '')}"`).join(',')}}`
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function withLabel(key: string, name: string, value: string): string {
  const pair = `${name}="${escapeLabel(value)}"`
  return key ? `${key.slice(0, -1)},${pair}}` : `{${pair}}`
}

interface Metric {
  render(): string[]
}

export class Counter implements Metric {
  private values = new Map<string, number>()

  constructor(
    readonly name: string,
    readonly help: string
  ) {}

  inc(labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels)
    this.values.set(key, (this.values.get(key) ?? 0) + amount)
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`]
    if (this.values.size === 0) lines.push(`${this.name} 0`)
    for (const [key, value] of this.values) lines.push(`${this.name}${key} ${value}`)
    return lines
  }
}

export class Gauge implements Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    private read: () => number | Array<[Labels, number]>
  ) {}

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`]
    let value: number | Array<[Labels, number]>
    try {
      value = this.read()
    } catch {
      return []
    }
    if (typeof value === 'number') {
      lines.push(`${this.name} ${value}`)
    } else {
      for (const [labels, entry] of value) lines.push(`${this.name}${labelKey(labels)} ${entry}`)
    }
    return lines
  }
}

export class Histogram implements Metric {
  private series = new Map<string, { counts: number[]; sum: number; count: number }>()

  constructor(
    readonly name: string,
    readonly help: string,
    private buckets: number[]
  ) {}

  observe(labels: Labels, value: number): void {
    const key = labelKey(labels)
    let entry = this.series.get(key)
    if (!entry) {
      entry = { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 }
      this.series.set(key, entry)
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) entry.counts[i]!++
    }
    entry.sum += value
    entry.count++
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`]
    for (const [key, entry] of this.series) {
      this.buckets.forEach((bucket, i) => lines.push(`${this.name}_bucket${withLabel(key, 'le', String(bucket))} ${entry.counts[i]}`))
      lines.push(`${this.name}_bucket${withLabel(key, 'le', '+Inf')} ${entry.count}`)
      lines.push(`${this.name}_sum${key} ${entry.sum}`)
      lines.push(`${this.name}_count${key} ${entry.count}`)
    }
    return lines
  }
}

class Registry {
  private metrics: Metric[] = []

  counter(name: string, help: string): Counter {
    return this.add(new Counter(name, help))
  }

  histogram(name: string, help: string, buckets: number[]): Histogram {
    return this.add(new Histogram(name, help, buckets))
  }

  gauge(name: string, help: string, read: () => number | Array<[Labels, number]>): Gauge {
    return this.add(new Gauge(name, help, read))
  }

  private add<T extends Metric>(metric: T): T {
    this.metrics.push(metric)
    return metric
  }

  render(): string {
    return this.metrics.flatMap((metric) => metric.render()).join('\n') + '\n'
  }
}

export const registry = new Registry()

export const httpRequests = registry.counter('nzip_http_requests_total', 'HTTP requests by route, method and status')
export const rateLimited = registry.counter('nzip_rate_limited_total', 'Requests refused by a rate limit, by kind (search, ws_upgrade, ws_message)')
export const archiveLookups = registry.counter('nzip_archive_lookups_total', 'Download flows answered from a stored archive (hit) or by downloading (miss)')
export const archiveEvicted = registry.counter('nzip_archive_evicted_total', 'Archives deleted from S3 by eviction')
export const archiveEvictedBytes = registry.counter('nzip_archive_evicted_bytes_total', 'Bytes deleted from S3 by eviction')
export const s3Requests = registry.counter('nzip_s3_requests_total', 'S3 requests by operation and result')
export const s3Duration = registry.histogram('nzip_s3_request_duration_seconds', 'S3 request latency by operation', [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60])
export const coreRestarts = registry.counter('nzip_core_restarts_total', 'Restarts of the Go core process')
export const coreCallTimeouts = registry.counter('nzip_core_call_timeouts_total', 'Core commands that got no answer in time, by command')
export const metadataCache = registry.counter('nzip_metadata_cache_total', 'Gallery API lookups by result (hit, shared, miss)')

/** Times an S3 call and counts its outcome */
export async function timeS3<T>(op: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    const result = await run()
    s3Requests.inc({ op, result: 'ok' })
    return result
  } catch (error) {
    s3Requests.inc({ op, result: 'error' })
    throw error
  } finally {
    s3Duration.observe({ op }, (performance.now() - started) / 1000)
  }
}

export default registry
