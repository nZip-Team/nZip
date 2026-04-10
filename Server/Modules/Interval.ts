export interface IntervalHandle {
  stop(): void
}

interface IntervalOptions {
  unref?: boolean
}

function msUntilNextBoundary(intervalMs: number, now: number = Date.now()): number {
  const remainder = now % intervalMs
  return remainder === 0 ? intervalMs : intervalMs - remainder
}

export function startInterval(
  callback: () => void | Promise<void>,
  intervalMs: number,
  options: IntervalOptions = {}
): IntervalHandle {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`Invalid intervalMs: ${intervalMs}`)
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const scheduleNext = () => {
    if (stopped) return

    timer = setTimeout(tick, msUntilNextBoundary(intervalMs))
    if (options.unref && timer && typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }
  }

  const tick = () => {
    if (stopped) return

    scheduleNext()
    void callback()
  }

  scheduleNext()

  return {
    stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
