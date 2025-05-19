import { $ } from 'bun'
import { readFile, writeFile } from 'fs/promises'
import path from 'path'
import Log from '@icebrick/log'

async function getPackageVersion(): Promise<string> {
  const packageJsonPath = path.resolve(__dirname, '../package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'))
  return packageJson.version
}

async function updateDockerfile(version: string): Promise<void> {
  const dockerfilePath = path.resolve(__dirname, '../Dockerfile')
  const dockerfile = await readFile(dockerfilePath, 'utf-8')
  const updatedDockerfile = dockerfile.replace(/LABEL org\.opencontainers\.image\.version=".*"/, `LABEL org.opencontainers.image.version="${version}"`)
  await writeFile(dockerfilePath, updatedDockerfile)
}

async function buildDockerImage(version: string): Promise<void> {
  const imageName = `ghcr.io/nzip-team/nzip:${version}`
  const tags = [`ghcr.io/nzip-team/nzip:latest`, `ghcr.io/nzip-team/nzip:${version.split('.')[0]}`, `ghcr.io/nzip-team/nzip:${version.split('.').slice(0, 2).join('.')}`]

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
