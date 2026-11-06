#!/bin/sh
# Replace the compose.ha.yml instances one at a time.
#   sh Scripts/rolling-update.sh [--no-pull]
#   COMPOSE="docker compose -p nzip -f /srv/nzip/compose.ha.yml" sh Scripts/rolling-update.sh

set -eu

COMPOSE=${COMPOSE:-"docker compose -f compose.ha.yml"}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-180}

wait_healthy() {
  # No locals in POSIX sh: prefixed names keep the loop variable intact
  wh_service=$1
  wh_waited=0
  while :; do
    wh_id=$($COMPOSE ps -q "$wh_service")
    wh_status=$([ -n "$wh_id" ] && docker inspect -f '{{.State.Health.Status}}' "$wh_id" 2>/dev/null || echo missing)
    [ "$wh_status" = healthy ] && return 0
    if [ "$wh_waited" -ge "$HEALTH_TIMEOUT" ]; then
      echo "$wh_service is $wh_status after ${HEALTH_TIMEOUT}s, stopping the rollout" >&2
      return 1
    fi
    sleep 2
    wh_waited=$((wh_waited + 2))
  done
}

if [ "${1:-}" != "--no-pull" ]; then
  $COMPOSE pull nzip-a nzip-b
fi

for service in nzip-a nzip-b; do
  other=$([ "$service" = nzip-a ] && echo nzip-b || echo nzip-a)
  # Never take an instance down while the other one is not serving
  wait_healthy "$other"
  echo "Replacing $service..."
  $COMPOSE up -d --no-deps --force-recreate "$service"
  wait_healthy "$service"
  echo "$service is healthy"
done

echo "Rolling update complete"
