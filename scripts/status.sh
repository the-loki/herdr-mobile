#!/bin/sh
# One-shot smoke test: is the service answering, and on which address?
set -eu

state_dir="${HERDR_PLUGIN_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr-mobile}"
url_file="$state_dir/url.txt"
port="${HERDR_MOBILE_PORT:-7777}"
host="${HERDR_MOBILE_HOST:-127.0.0.1}"

printf '\n  herdr web status\n\n'
printf '  state dir  %s\n' "$state_dir"
printf '  socket     %s\n' "${HERDR_SOCKET_PATH:-<herdr default>}"
printf '  bind       %s:%s\n' "$host" "$port"

if [ -s "$url_file" ]; then
  printf '  link       %s\n' "$(cat "$url_file")"
else
  printf '  link       (not started yet)\n'
fi

code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/health" || true)"
printf '  health     HTTP %s\n\n' "${code:-000}"

case "$code" in
  200) printf '  Running. Anything else means start it with:\n    herdr plugin action invoke herdr-mobile.web.serve\n\n' ;;
  401) printf '  Running, and refusing unauthenticated requests (expected for /api/state).\n\n' ;;
  *) printf '  Not answering on 127.0.0.1:%s. Start it with:\n    herdr plugin action invoke herdr-mobile.web.serve\n\n' "$port" ;;
esac
