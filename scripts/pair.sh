#!/bin/sh
# Print the pairing link for the running service and wait, so the overlay stays
# readable instead of vanishing the moment the command exits.
set -eu

state_dir="${HERDR_PLUGIN_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr-mobile}"
url_file="$state_dir/url.txt"

if [ ! -s "$url_file" ]; then
  printf '\n  No pairing link yet.\n\n  Start the server first: herdr plugin action invoke herdr-mobile.web.serve\n\n'
  printf '  Press Enter to close. '
  read -r _
  exit 0
fi

url="$(cat "$url_file")"
printf '\n  Open this on your phone or computer:\n\n  %s\n\n' "$url"

if command -v qrencode >/dev/null 2>&1; then
  qrencode -t ansiutf8 -m 1 "$url" || true
else
  printf '  (install qrencode for a scannable QR code)\n'
fi

printf '\n  Press Enter to close. '
read -r _
