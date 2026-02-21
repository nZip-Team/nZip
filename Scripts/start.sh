#!/bin/sh

bun install -p
if [ -n "$1" ]; then
  bun Cluster.js $1
else
  bun Main.js
fi
