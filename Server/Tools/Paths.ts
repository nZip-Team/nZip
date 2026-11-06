import path from 'path'

/**
 * Resolve a user supplied name inside a base directory
 * @param userInput The user input path
 * @param baseDir The base directory to resolve against
 * @returns The resolved path, or null when it would leave the base directory
 */
export function sanitizePath(userInput: string, baseDir: string): string | null {
  const normalized = userInput.replace(/\\/g, '/')

  const basePath = path.isAbsolute(baseDir) ? path.resolve(baseDir) : path.resolve(path.join(process.cwd(), baseDir))
  const fullPath = path.resolve(path.join(basePath, normalized))
  const relative = path.relative(basePath, fullPath)

  if (relative === '' || relative === '.') {
    return fullPath
  }

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }

  return fullPath
}

const ARCHIVE_CONTENT_TYPES: Record<string, string> = {
  '.zip': 'application/zip',
  '.cbz': 'application/vnd.comicbook+zip',
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip'
}

/** @returns The content type of an archive name, or null for anything else */
export function getArchiveContentType(fileName: string): string | null {
  const extension = path.extname(fileName)
  return ARCHIVE_CONTENT_TYPES[extension] ?? null
}
