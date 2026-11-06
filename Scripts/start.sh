#!/bin/sh

[ -d node_modules ] || bun install -p

case "${1:-}" in
  ''|*[!0-9]*)
    exec bun Main.js
    ;;
  *)
    if [ "$1" -gt 0 ]; then
      exec bun Cluster.js "$1"
    else
      exec bun Main.js
    fi
    ;;
esac
