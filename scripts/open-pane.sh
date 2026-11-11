#!/bin/sh
# Open one of this plugin's panes from an action. Actions are one-shot commands;
# the pane is where the long-lived work lives.
set -eu

entrypoint="${1:?usage: open-pane.sh serve|pair}"
herdr="${HERDR_BIN_PATH:-herdr}"

case "$entrypoint" in
  serve) placement="tab" ;;
  *) placement="overlay" ;;
esac

# An action invoked from the CLI has no pane context, so fall back to the first
# workspace herdr reports. A pane launched from a pane inherits its workspace.
workspace="${HERDR_WORKSPACE_ID:-}"
if [ -z "$workspace" ]; then
  workspace="$("$herdr" workspace list 2>/dev/null | sed -n 's/.*"workspace_id":"\([^"]*\)".*/\1/p' | head -1 || true)"
fi

set -- --plugin "${HERDR_PLUGIN_ID:-herdr-mobile.web}" --entrypoint "$entrypoint" --placement "$placement" --focus
if [ -n "$workspace" ]; then
  set -- "$@" --workspace "$workspace"
fi

if ! "$herdr" plugin pane open "$@"; then
  printf '\n  Could not open the %s pane.\n\n' "$entrypoint" >&2
  printf '  Start a workspace in herdr first, then retry:\n' >&2
  printf '    herdr plugin action invoke herdr-mobile.web.%s\n\n' "$entrypoint" >&2
  exit 1
fi
