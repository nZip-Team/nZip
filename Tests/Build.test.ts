import fs from 'fs'
import path from 'path'
import { describe, expect, test } from 'bun:test'

const root = path.join(import.meta.dir, '..')

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return ['node_modules', 'dist', 'Tests', 'Scripts'].includes(entry.name) ? [] : sources(full)
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

describe('build', () => {
  // Bun.build replaces process.env.NODE_ENV with the build's mode, so a production image would behave as development
  test('server code reads NODE_ENV at run time, not through the form the bundler replaces', () => {
    const files = [...sources(path.join(root, 'Server')), path.join(root, 'Config.ts'), path.join(root, 'Main.ts'), path.join(root, 'Cluster.ts')]
    const offenders = files.filter((file) => /process\.env\.NODE_ENV/.test(fs.readFileSync(file, 'utf8')))

    expect(offenders.map((file) => path.relative(root, file))).toEqual([])
  })
})
