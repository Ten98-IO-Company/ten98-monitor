#!/bin/sh
# POSIX shell host helper. No Docker socket is mounted into a container.
set -eu
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
case "$PWD" in *,*) fail 'Move the checkout to a path without commas before using Docker bind mounts.' ;; esac
[ "$#" -eq 0 ] || [ "$#" -eq 4 ] || fail 'Usage: sh scripts/deploy.sh [local|proxy|caddy APP_URL APP_PORT PROJECT_NAME]'
command -v docker >/dev/null 2>&1 || fail 'Install Docker Engine or Docker Desktop with Compose, then retry.'
endpoint=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
case "$endpoint" in unix://*|npipe://*) ;; *) fail 'Run setup on the Docker host. Remote Docker contexts are not supported by this helper.' ;; esac
server=$(docker version --format '{{.Server.Version}} {{.Server.Os}}') || fail 'Start the Docker daemon, then retry.'
case "$server" in *' linux') ;; *) fail 'Select Linux containers in Docker Desktop, then retry.' ;; esac
major=${server%%.*}
[ "$major" -ge 28 ] 2>/dev/null || fail 'Docker Engine 28 or newer is required for the documented loopback port isolation.'
docker compose up --help | grep -q -- --wait-timeout || fail 'Update Docker Compose to a version supporting up --wait-timeout.'
docker info --format 'Docker: {{.OSType}}/{{.Architecture}}, CPUs={{.NCPU}}, daemon memory bytes={{.MemTotal}}'
printf '%s\n' 'These are detected resources, not a tested capacity guarantee.'

if [ "$#" -eq 4 ]; then
  [ ! -e .env ] && [ ! -L .env ] || fail '.env already exists. Run without arguments to resume; never replace saved secrets.'
  case "$4" in ''|*[!a-z0-9_-]*|[-_]*) fail 'Project name must start with a lowercase letter/digit and contain only lowercase letters, digits, underscores or hyphens.' ;; esac
  [ "${#4}" -le 63 ] || fail 'Project name must be at most 63 characters.'
  existing=$(docker volume ls -q --filter "label=com.docker.compose.project=$4")
  containers=$(docker ps -aq --filter "label=com.docker.compose.project=$4")
  [ -z "$existing$containers" ] || fail 'This project already has Docker state. Restore its original .env; setup will not generate replacement secrets.'
  if docker volume inspect "${4}_pgdata" >/dev/null 2>&1; then fail 'The database volume already exists. Restore the original configuration before continuing.'; fi
fi

# No published release image yet: the source build is cached by Docker.
# Distinct checkouts must not race by replacing a shared helper image tag.
helper_image="ten98-monitor:setup-$(printf '%s' "$PWD" | cksum | cut -d' ' -f1)"
docker build --tag "$helper_image" .
helper() {
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" --mount "type=bind,source=$PWD,target=/setup" --workdir /setup \
    "$helper_image" node /app/scripts/docker-setup.mjs "$@"
}
helper storage
if [ "$#" -eq 4 ]; then helper setup "$@"; fi
metadata=$(helper inspect)
IFS=' ' read -r mode app_url app_port project <<EOF
$metadata
EOF
[ -n "$project" ] || fail 'Deployment metadata is missing. Read https://github.com/Ten98-IO-Company/ten98-discover/wiki/Deployment before adopting an existing configuration.'
image="ten98-monitor:$project"
docker tag "$helper_image" "$image"
# Compose gives inherited shell variables precedence over .env. Never mix an
# unrelated shell's credentials/origin into this installation.
unset APP_URL APP_PORT AUTH_SECRET POSTGRES_PASSWORD DATABASE_URL ARTIFACT_DIR CREDENTIAL_KEYS CREDENTIAL_ACTIVE_KEY COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME
export TEN98_IMAGE="$image"
compose() {
  if [ "$mode" = caddy ]; then
    docker compose --env-file .env --project-name "$project" -f compose.yaml -f compose.caddy.yaml "$@"
  else
    docker compose --env-file .env --project-name "$project" -f compose.yaml "$@"
  fi
}
compose config --quiet
if [ -z "$(compose ps --status running -q web)" ]; then
  docker run --rm --label "io.ten98.setup-project=$project" -p "127.0.0.1:$app_port:3000" "$image" node -e '' \
    || fail 'The selected loopback app port could not be allocated. Fix the conflict and rerun without arguments.'
fi
if [ "$mode" = caddy ] && [ -z "$(compose ps --status running -q caddy)" ]; then
  docker run --rm --label "io.ten98.setup-project=$project" -p 80:80 -p 443:443 "$image" node -e '' \
    || fail 'Caddy ports 80/443 could not be allocated. Use an existing proxy or resolve the conflict; no volume was removed.'
fi
printf '%s\n' 'Before upgrading existing data, take the documented recoverable backup. Stopping app writers for explicit migration.'
compose stop web worker
if ! compose run --rm migrate; then
  fail 'Migration failed. Web and worker remain stopped; configuration and volumes are preserved. Review the migration guidance before restarting.'
fi
if [ "$mode" = caddy ]; then
  compose up -d --no-build --wait --wait-timeout 180 web worker caddy
else
  compose up -d --no-build --wait --wait-timeout 180 web worker
fi
compose exec -T worker node src/server/cli.ts diagnose worker
printf 'Application and worker checks passed. Open %s\n' "$app_url"
printf '%s\n' 'Create the first account now: it becomes the owner. Until then anyone who can reach the app can claim it.'
if [ "$mode" != local ]; then
  printf '%s\n' 'Public DNS, browser-trusted HTTPS and collection from another device still require the external checks in https://github.com/Ten98-IO-Company/ten98-discover/wiki/Deployment.'
fi
