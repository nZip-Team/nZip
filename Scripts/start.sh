#!/bin/sh

[ -d node_modules ] || bun install -p

# Started as root (the image default): give the cache volume to the bun user and drop to it.
# Volumes written by images before 1.15.4, which ran as root, hold root-owned files.
# NZIP_RUN_AS_ROOT=true keeps root, for hosts that cannot change the volume's owner.
if [ "$(id -u)" = 0 ] && [ "${NZIP_RUN_AS_ROOT:-}" != true ] && id bun >/dev/null 2>&1; then
  mkdir -p Cache
  find Cache \( ! -user bun -o ! -group bun \) -exec chown -h bun:bun {} + 2>/dev/null || true
  # BusyBox su execs in place (bun stays PID 1 and gets SIGTERM) and keeps the environment with -p
  HOME=/home/bun exec su -p -s /bin/sh bun "$0" "$@"
fi

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
