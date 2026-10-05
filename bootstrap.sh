#!/usr/bin/env bash
#
# Stand the kitchen dashboard up on a fresh host.
#
#   git clone https://github.com/YOUR-USER/kitchen-dash.git ~/apps/kitchen-dash
#   cd ~/apps/kitchen-dash && ./bootstrap.sh
#
# There is no build and no dependency install: server.js uses only Node's
# standard library. This script checks the host, places the secrets file and the
# systemd unit, starts the service, and verifies it answers.
#
# Idempotent. Reads no secret values and prints none.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HOME/.config/kitchen-dash/env"
UNIT_DIR="$HOME/.config/systemd/user"
PORT="${PORT:-8788}"

say() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# --- node -----------------------------------------------------------------
command -v node >/dev/null || die "node is not installed."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node 20+ required, found $(node --version)."
say "node $(node --version) — no dependencies to install"

# --- tests ----------------------------------------------------------------
say "running library tests"
( cd "$REPO/api" && node --test test/*.test.js >/dev/null ) \
  && say "tests pass" \
  || die "tests failed — fix before deploying."

# --- secrets --------------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  mkdir -p "$(dirname "$ENV_FILE")"
  install -m 600 "$REPO/.env.example" "$ENV_FILE"
  say "created $ENV_FILE from .env.example (mode 600)"
  die "Fill in the values in $ENV_FILE, then re-run this script."
fi

chmod 600 "$ENV_FILE"
MISSING=()
for V in TENANT_ID CLIENT_ID CLIENT_SECRET CALENDAR_MAILBOX; do
  grep -qE "^${V}=.+" "$ENV_FILE" || MISSING+=("$V")
done
[ ${#MISSING[@]} -eq 0 ] || die "$ENV_FILE is missing values for: ${MISSING[*]}"
grep -qE '^WAQI_TOKEN=.+' "$ENV_FILE" \
  || say "NOTE: WAQI_TOKEN is empty — AQI will be disabled (not fatal)."
say "secrets present (mode 600) — no values read or printed"

# --- systemd --------------------------------------------------------------
mkdir -p "$UNIT_DIR"
# WorkingDirectory/ExecStart in the shipped unit are absolute. Rewrite them to
# wherever this clone actually lives, so the unit is not tied to one host layout.
sed -e "s|^WorkingDirectory=.*|WorkingDirectory=${REPO}|" \
    -e "s|^ExecStart=.*|ExecStart=/usr/bin/node ${REPO}/server.js|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=${ENV_FILE}|" \
    "$REPO/deploy/kitchen-dash.service" > "$UNIT_DIR/kitchen-dash.service"
chmod 644 "$UNIT_DIR/kitchen-dash.service"
systemctl --user daemon-reload
say "installed kitchen-dash.service (paths rewritten for ${REPO})"

if ! loginctl show-user "$USER" -p Linger --value 2>/dev/null | grep -q yes; then
  say "NOTE: lingering is off, so the dashboard stops when you log out. Enable with:"
  printf '       sudo loginctl enable-linger %s\n' "$USER"
fi

systemctl --user enable --now kitchen-dash
sleep 3

# --- verify ---------------------------------------------------------------
[ "$(curl -s "http://127.0.0.1:${PORT}/healthz" || true)" = "ok" ] \
  || { systemctl --user status kitchen-dash --no-pager | head -20; die "service is not answering on ${PORT}."; }
say "healthz ok on 127.0.0.1:${PORT}"

if curl -s "http://127.0.0.1:${PORT}/api/state?tz=$(date +%Z)" | grep -q timeZone; then
  say "calendar reachable"
else
  say "WARNING: /api/state did not return calendar data — check the Graph credential."
fi

cat <<NOTE

Done. The server is loopback-only by design; publish it with a reverse proxy.
With Tailscale:

    tailscale serve --bg --https 8443 --set-path /kitchen http://127.0.0.1:${PORT}

Then point the wall tablet at  https://<host>.<tailnet>.ts.net:8443/kitchen
Remember to update the kiosk browser's start URL when the host changes.

Logs: journalctl --user -u kitchen-dash -f
NOTE
