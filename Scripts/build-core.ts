import { $ } from 'bun'

import { version } from '../package.json'

await $`cd Core && go build -trimpath -ldflags="-s -w -X 'main.version=${version}'" -o nzip-core .`
