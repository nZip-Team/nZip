import { $ } from 'bun'

await $`cp -r App dist`
await $`rm -rf dist/App/Pages`
// icon.png, icon.svg and logo.png are served: apple-touch-icon, manifest icons, og:image
await $`rm -f dist/App/Images/logo.ico dist/App/Images/logo.svg`

if (Bun.which('go')) {
  await $`bun run build:core`
  await $`cp Core/nzip-core dist`
}
