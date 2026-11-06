// Preference cookies shared by the client scripts; Frame.tsx reads blur and theme before paint

const ONE_YEAR = 365 * 24 * 60 * 60

export function getCookie(name: string): string | null {
  for (const part of document.cookie.split(';')) {
    const index = part.indexOf('=')
    if (index === -1 || part.slice(0, index).trim() !== name) continue
    const value = part.slice(index + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return null
}

export function setCookie(name: string, value: string, maxAge = ONE_YEAR): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAge}; path=/; SameSite=Lax`
}

export function deleteCookie(name: string): void {
  setCookie(name, '', 0)
}
