#!/bin/sh

bun install -p

case "${1:-}" in
  ''|*[!0-9]*)
    bun Main.js
    ;;
  *)
    if [ "$1" -gt 0 ]; then
      bun Cluster.js "$1"
    else
      bun Main.js
    fi
    ;;
esac
