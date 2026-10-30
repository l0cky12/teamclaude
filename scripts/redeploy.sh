#!/usr/bin/env bash
# One command to update a TeamClaude that runs with docker compose from this
# checkout: pull, rebuild, restart, check it is healthy. The new image is
# built while the old container keeps serving, so the proxy is down only for
# the few seconds the container swap takes. If the new container does not
# pass the image's health check, the previous image is put back, so a broken
# build never leaves you (or an agent that runs this) without a proxy.
#
#   scripts/redeploy.sh             pull, rebuild and restart if anything changed
#   scripts/redeploy.sh --force     rebuild and restart even if nothing changed
#   scripts/redeploy.sh --no-pull   rebuild what is checked out, without pulling
#
# Environment:
#   TEAMCLAUDE_SERVICE           compose service to redeploy (default: teamclaude)
#   TEAMCLAUDE_REDEPLOY_TIMEOUT  seconds to wait for a healthy container (default: 90)
#   COMPOSE_FILE                 read by docker compose itself, if your file is elsewhere

set -euo pipefail

# Everything runs inside main, which bash parses in full before running it,
# so a git pull that rewrites this file cannot change it under our feet.
main() {
service=${TEAMCLAUDE_SERVICE:-teamclaude}
timeout=${TEAMCLAUDE_REDEPLOY_TIMEOUT:-90}
pull=1
force=0

usage() { sed -n '2,17s/^# \{0,1\}//p' "$0"; }

for arg in "$@"; do
  case $arg in
    --force) force=1 ;;
    --no-pull) pull=0 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "redeploy: unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
die() { printf 'redeploy: %s\n' "$*" >&2; exit 1; }

# Run from the checkout root, wherever the script is called from, so
# docker compose finds the docker-compose.yml that sits next to the source.
cd "$(dirname "$0")/.."

# Two overlapping runs would race on the image tags.
if command -v flock >/dev/null; then
  exec 9>"$(git rev-parse --git-dir)/redeploy.lock"
  flock -n 9 || die "another redeploy is already running"
fi

docker compose config --services 2>/dev/null | grep -qx "$service" \
  || die "no compose service named '$service' here ($(pwd)). Run this from the checkout that has your docker-compose.yml, or set TEAMCLAUDE_SERVICE / COMPOSE_FILE."
image=$(docker compose config --images "$service")
[ -n "$image" ] || die "service '$service' has no image name to tag"

# teamclaude:local -> teamclaude:previous (the tag is only stripped when it
# is after the last slash, so a registry port is not mistaken for one).
repo=$image
case ${image##*/} in *:*) repo=${image%:*} ;; esac
previous="$repo:previous"

if [ "$pull" = 1 ]; then
  before=$(git rev-parse --short HEAD)
  say "Pulling $(git rev-parse --abbrev-ref HEAD)"
  git pull --ff-only || die "git pull failed; nothing was rebuilt and the proxy is untouched"
  after=$(git rev-parse --short HEAD)
  if [ "$before" = "$after" ]; then say "No new commits"; else say "Updated $before -> $after"; fi
  # Carry on with the version of this script that was just pulled.
  if ! git diff --quiet "$before" "$after" -- scripts/redeploy.sh; then
    exec scripts/redeploy.sh --no-pull "$@"
  fi
fi
head=$(git rev-parse HEAD)

cid=$(docker compose ps -q "$service")
if [ -n "$cid" ] && [ "$force" = 0 ]; then
  running=$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$cid")
  if [ "$running" = "$head" ]; then
    say "Already running $(git rev-parse --short HEAD); nothing to do (use --force to rebuild anyway)"
    exit 0
  fi
fi

# Keep what is running now as the rollback target.
old_previous=$(docker image inspect -f '{{.Id}}' "$previous" 2>/dev/null || true)
if [ -n "$cid" ]; then
  docker tag "$(docker inspect -f '{{.Image}}' "$cid")" "$previous"
elif docker image inspect "$image" >/dev/null 2>&1; then
  docker tag "$image" "$previous"
else
  previous=
fi

version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -n 1)
say "Building $image ($version, $(git rev-parse --short HEAD)); the proxy keeps running meanwhile"
docker compose build \
  --build-arg "VERSION=${version:-dev}" \
  --build-arg "VCS_REF=$head" \
  --build-arg "BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$service" || die "build failed; the running proxy was not touched"
built=$(docker image inspect -f '{{.Id}}' "$image")

# 0: healthy. 1: not yet. 2: the container stopped or is crash-looping, so
# there is no point waiting out the timeout. The check is the image's own
# HEALTHCHECK command, run now rather than at Docker's next scheduled probe
# (every 30 s).
healthy() {
  local id check
  id=$(docker compose ps -aq "$service")
  [ -n "$id" ] || return 1
  case $(docker inspect -f '{{.State.Status}}' "$id") in
    running) ;;
    exited | dead | restarting) return 2 ;;
    *) return 1 ;;
  esac
  check=$(docker inspect -f '{{with .Config.Healthcheck}}{{if eq (index .Test 0) "CMD-SHELL"}}{{index .Test 1}}{{end}}{{end}}' "$id")
  [ -z "$check" ] || docker exec "$id" sh -c "$check" >/dev/null 2>&1
}

wait_healthy() {
  local deadline=$((SECONDS + timeout)) rc
  while :; do
    rc=0
    healthy || rc=$?
    [ "$rc" != 0 ] || return 0
    [ "$rc" != 2 ] && [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 2
  done
}

# Old builds would otherwise pile up, one per redeploy. Only an image no tag
# points at any more is removed, so :previous, the live tag and any tag of
# your own are never touched.
drop_if_untagged() {
  if [ -n "$1" ] && [ "$(docker image inspect -f '{{len .RepoTags}}' "$1" 2>/dev/null)" = 0 ]; then
    docker rmi "$1" >/dev/null 2>&1 || true
  fi
}

say "Restarting $service"
docker compose up -d --no-build "$service"

if wait_healthy; then
  drop_if_untagged "$old_previous"
  say "Done: $service is healthy on $(git rev-parse --short HEAD)"
  exit 0
fi

echo "redeploy: $service did not come up healthy. Last log lines:" >&2
docker compose logs --tail 40 "$service" >&2 || true
[ -n "$previous" ] || die "no previous image to roll back to"

say "Rolling back to the previous image"
docker tag "$previous" "$image"
docker compose up -d --no-build "$service"
wait_healthy || die "the previous image is not healthy either; check 'docker compose logs $service'"
drop_if_untagged "$built"
drop_if_untagged "$old_previous"
die "rolled back; the proxy is running the previous image. The checkout stays at $(git rev-parse --short HEAD) so you can fix it and re-run."
}

main "$@"
