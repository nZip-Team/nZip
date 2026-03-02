import { $ } from 'bun'
import { readFile } from 'fs/promises'
import path from 'path'
import Log from '../Server/Modules/Log'

async function getPackageVersion(): Promise<string> {
  const packageJsonPath = path.join(process.cwd(), 'package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'))
  return packageJson.version
}

async function getGitRevision(): Promise<string> {
  try {
    const result = await $`git rev-parse --short HEAD`.text()
    return result.trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

async function buildDockerImage(version: string): Promise<void> {
  const imageName = `ghcr.io/nzip-team/nzip:${version}`
  const created = new Date().toISOString()
  const revision = await getGitRevision()

  const versionParts = version.split('-')
  const baseVersion = versionParts[0]
  const suffix = versionParts.length > 1 ? `-${versionParts.slice(1).join('-')}` : ''

  const [major, minor, _patch] = baseVersion.split('.')

  const tags = [
    `ghcr.io/nzip-team/nzip:${major}${suffix}`,
    `ghcr.io/nzip-team/nzip:${major}.${minor}${suffix}`,
    `ghcr.io/nzip-team/nzip:${version}`
  ]

  if (!suffix) {
    tags.unshift(`ghcr.io/nzip-team/nzip:latest`)
  }

  console.log(tags)

  const allTags = Array.from(new Set([imageName, ...tags]))

  Log.info('Building and pushing multi-arch Docker images (linux/amd64, linux/arm64)...')
  const tagArgs = allTags.flatMap((tag) => ['-t', tag])
  await $`docker buildx build --platform linux/amd64,linux/arm64 ${tagArgs} --build-arg VERSION=${version} --build-arg REVISION=${revision} --build-arg CREATED=${created} --push .`

  Log.success('Docker image build and push complete.')
}

async function main() {
  try {
    const version = await getPackageVersion()
    await buildDockerImage(version)
  } catch (error) {
    Log.error('Error building Docker image:', error)
    process.exit(1)
  }
}

main()
