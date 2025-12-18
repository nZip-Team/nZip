import { $ } from 'bun'

if (await Bun.file('.env').exists()) await $`cp .env dist`

await $`cp -r App dist`
await $`rm -rf dist/App/Pages`
await $`rm dist/App/Images/icon.png dist/App/Images/icon.svg dist/App/Images/logo.*`

await $`bun ./Scripts/bundle-pages.ts`
