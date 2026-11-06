#!/bin/sh
# Replace the compose.ha.yml instances one at a time, then the cloudflared connectors.
#   sh Scripts/rolling-update.sh [--no-pull]
#   COMPOSE="docker compose -p nzip -f /srv/nzip/compose.ha.yml" sh Scripts/rolling-update.sh

set -eu

COMPOSE=${COMPOSE:-"docker compose -f compose.ha.yml"}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-180}

is_ready() {
  case "$1" in
    nzip-*)
      ir_id=$($COMPOSE ps -q "$1")
      [ -n "$ir_id" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$ir_id" 2>/dev/null)" = healthy ]
      ;;
    # The cloudflared image has no shell, so ask its metrics server from the load balancer
    cloudflared-*)
      $COMPOSE exec -T nzip-lb wget -qO /dev/null "http://$1:2000/ready" >/dev/null 2>&1
      ;;
  esac
}

wait_ready() {
  # No locals in POSIX sh: prefixed names keep the loop variable intact
  wr_waited=0
  until is_ready "$1"; do
    if [ "$wr_waited" -ge "$HEALTH_TIMEOUT" ]; then
      echo "$1 is not ready after ${HEALTH_TIMEOUT}s, stopping the rollout" >&2
      return 1
    fi
    sleep 2
    wr_waited=$((wr_waited + 2))
  done
}

# Replace $1, never while its partner $2 is not serving
replace() {
  wait_ready "$2"
  echo "Replacing $1..."
  # cloudflared is only recreated when its image or settings changed
  case "$1" in
    nzip-*) $COMPOSE up -d --no-deps --force-recreate "$1" ;;
    *) $COMPOSE up -d --no-deps "$1" ;;
  esac
  wait_ready "$1"
  echo "$1 is ready"
}

if [ "${1:-}" != "--no-pull" ]; then
  $COMPOSE pull nzip-a nzip-b cloudflared-a cloudflared-b
fi

replace nzip-a nzip-b
replace nzip-b nzip-a
replace cloudflared-a cloudflared-b
replace cloudflared-b cloudflared-a

echo "Rolling update complete"
