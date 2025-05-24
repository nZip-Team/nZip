#!/bin/sh

rm -rf dist
mkdir -p dist
cp package.json dist
cp Scripts/start.sh dist

bun install

bun -e "import Bundle from './Server/Bundle'; await Bundle();"
