import { $ } from 'bun'

await $`rm -rf dist`
await $`mkdir -p dist`
await $`cp package.json dist`
await $`cp Scripts/start.sh dist`

await $`bun install`

await $`bun -e "import Bundle from './Server/Bundle'; await Bundle();"`
