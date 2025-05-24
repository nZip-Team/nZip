import { $ } from 'bun'

await $`cp -r App dist`
await $`rm -rf dist/App/Pages`
await $`rm dist/App/Images/icon.png dist/App/Images/icon.svg dist/App/Images/logo.*`
