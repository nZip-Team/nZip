import { $ } from 'bun'
import { readFile, writeFile } from 'fs/promises'
import path from 'path'
import Log from '@icebrick/log'

async function getPackageVersion(): Promise<string> {
  const packageJsonPath = path.join(process.cwd(), 'package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'))
  return packageJson.version
}

async function updateDockerfile(version: string): Promise<void> {
  const dockerfilePath = path.join(process.cwd(), 'Dockerfile')
  const dockerfile = await readFile(dockerfilePath, 'utf-8')
  const created = new Date().toISOString()
  const updatedDockerfile = dockerfile
    .replace(/LABEL org\.opencontainers\.image\.version=".*"/, `LABEL org.opencontainers.image.version="${version}"`)
    .replace(/LABEL org\.opencontainers\.image\.created=".*"/, `LABEL org.opencontainers.image.created="${created}"`)
  await writeFile(dockerfilePath, updatedDockerfile)
}

async function buildDockerImage(version: string): Promise<void> {
  const imageName = `ghcr.io/nzip-team/nzip:${version}`

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

  Log.info('Updating Dockerfile...')
  await updateDockerfile(version)

  Log.info('Pulling latest base image...')
  await $`docker pull oven/bun:alpine`

  Log.info(`Building Docker image: ${imageName}`)
  await $`docker build -t ${imageName} .`

  Log.info('Tagging Docker image...')
  for (const tag of tags) {
    await $`docker tag ${imageName} ${tag}`
  }

  Log.info('Pushing Docker images...')
  for (const tag of [imageName, ...tags]) {
    await $`docker push ${tag}`
  }

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
