// Download history kept in this browser only

export interface HistoryEntry {
  id: string
  title: string
  format: string
  date: number
}

const KEY = 'nzip-history'
const MAX_ENTRIES = 50

export function readHistory(): HistoryEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is HistoryEntry => !!entry && typeof entry.id === 'string' && typeof entry.title === 'string' && typeof entry.format === 'string' && typeof entry.date === 'number')
  } catch {
    return []
  }
}

export function addHistory(entry: Omit<HistoryEntry, 'date'>): void {
  const entries = [{ ...entry, date: Date.now() }, ...readHistory().filter((old) => old.id !== entry.id)].slice(0, MAX_ENTRIES)
  try {
    localStorage.setItem(KEY, JSON.stringify(entries))
  } catch {
    // Storage full or disabled; history is a nicety
  }
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing to clear
  }
}
