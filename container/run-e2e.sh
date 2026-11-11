#!/usr/bin/env bash
# Full acceptance run, executed inside the test container.
#
#   docker run --rm -v "$PWD:/work" -v "$HOME/.pi/agent:/pi-src:ro" \
#     herdr-mobile-test bash container/run-e2e.sh
#
# It starts a real herdr server, starts pi in a pane with this machine's pi
# configuration, links the plugin, serves the built web client, and drives it in
# headless Chromium at a phone and a desktop viewport.
set -euo pipefail
cd /work

export HERDR_PLUGIN_STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-/tmp/hmw-state}"
export HERDR_MOBILE_PORT="${HERDR_MOBILE_PORT:-7777}"
export E2E_ARTIFACTS="${E2E_ARTIFACTS:-/work/container/artifacts}"
# puppeteer-core is installed globally in the image, not in the repo.
export NODE_PATH="${NODE_PATH:-/usr/local/lib/node_modules}"
BASE="http://127.0.0.1:${HERDR_MOBILE_PORT}"

banner() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*"; exit 1; }

mkdir -p "$HERDR_PLUGIN_STATE_DIR" "$E2E_ARTIFACTS"

banner "1/7 this machine's pi configuration"
PI_CONFIG_SRC="${PI_CONFIG_SRC:-/pi-src}" bash container/prepare-pi-config.sh

banner "2/7 herdr server"
nohup herdr server > /tmp/herdr-server.log 2>&1 &
for _ in $(seq 1 60); do herdr status server 2>/dev/null | grep -q 'status: running' && break; sleep 0.5; done
herdr status server | sed 's/^/  /'

# The integration is what makes herdr report an agent_session (the transcript
# path) for a pane; without it the conversation view has nothing to read.
herdr integration install pi >/dev/null 2>&1 || true

banner "3/7 a workspace running pi"
mkdir -p /tmp/proj
workspace_json="$(herdr workspace create --cwd /tmp/proj --label demo)"
pane_id="$(printf '%s' "$workspace_json" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')"
herdr pane run "$pane_id" "pi" >/dev/null
for _ in $(seq 1 60); do herdr agent list 2>/dev/null | grep -q '"agent":"pi"' && break; sleep 1; done
herdr agent list | python3 -c '
import sys, json
agents = json.load(sys.stdin)["result"]["agents"]
summary = ", ".join("{}@{}={}".format(a["agent"], a["pane_id"], a["agent_status"]) for a in agents)
print("  " + (summary or "none"))
assert any(a["agent"] == "pi" for a in agents), "herdr did not detect pi in the pane"
' || fail "herdr did not detect pi in the pane"

banner "4/7 link the plugin"
herdr plugin link /work | head -c 400; echo
herdr plugin list --json | python3 -c '
import sys, json
plugins = json.load(sys.stdin)["result"]["plugins"]
match = [p for p in plugins if p["plugin_id"] == "herdr-mobile.web"]
assert match, "plugin herdr-mobile.web is registered"
assert match[0].get("enabled", True), "plugin is enabled"
print("  registered:", match[0]["plugin_id"], "v" + str(match[0].get("version")), "| enabled:", match[0].get("enabled"))
'

banner "5/7 start the service"
node src/main.mjs --host 127.0.0.1 --port "$HERDR_MOBILE_PORT" > /tmp/hmw-server.log 2>&1 &
server_pid=$!
sleep 0.5
for _ in $(seq 1 60); do
  [ -s "$HERDR_PLUGIN_STATE_DIR/url.txt" ] && break
  sleep 0.5
done
[ -s "$HERDR_PLUGIN_STATE_DIR/url.txt" ] || { cat /tmp/hmw-server.log; fail "the server never wrote its pairing link"; }
cat /tmp/hmw-server.log | sed 's/^/  /'

token="$(python3 -c '
import re, os
url = open(os.path.join(os.environ["HERDR_PLUGIN_STATE_DIR"], "url.txt")).read()
print(re.search(r"token=([A-Za-z0-9]+)", url).group(1))
')"
export E2E_TOKEN="$token"

banner "6/7 the token gate"
code_anon="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/state")"
code_auth="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/state?token=$token")"
echo "  anonymous /api/state → HTTP $code_anon (expect 401)"
echo "  paired    /api/state → HTTP $code_auth (expect 200)"
[ "$code_anon" = "401" ] || fail "unauthenticated API access was not refused"
[ "$code_auth" = "200" ] || fail "the pairing token did not grant access"

code_shell="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
echo "  app shell /          → HTTP $code_shell (expect 200)"
[ "$code_shell" = "200" ] || fail "the app shell was not served"

banner "7/7 browser acceptance (phone 390x844, desktop 1440x900)"
E2E_BASE_URL="$BASE" node container/e2e.mjs || { tail -40 /tmp/hmw-server.log; fail "browser acceptance failed"; }

banner "the plugin manifest path: action → pane → server"
herdr plugin action list --plugin herdr-mobile.web \
  | python3 -c 'import sys,json; a=json.load(sys.stdin)["result"]["actions"]; print("  actions: " + ", ".join(x["action_id"] for x in a))'

# Take the direct server down, then start it the way a user would: through the
# plugin action, which opens a pane and runs the manifest command.
kill "$server_pid" 2>/dev/null || true
for _ in $(seq 1 20); do curl -s -o /dev/null "$BASE/api/health" || break; sleep 0.2; done

herdr plugin action invoke herdr-mobile.web.serve >/dev/null
started=""
for _ in $(seq 1 60); do
  started="$(herdr pane list | python3 -c '
import sys, json
panes = json.load(sys.stdin)["result"]["panes"]
print(len(panes))
')"
  [ "${started:-0}" -ge 2 ] && break
  sleep 0.5
done
[ "${started:-0}" -ge 2 ] || fail "the serve action did not open a pane"

served=""
for _ in $(seq 1 60); do
  served="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health" || true)"
  [ "$served" = "401" ] && break
  sleep 0.5
done
echo "  plugin-launched server /api/health (no token) → HTTP ${served:-000} (expect 401: running and gated)"
[ "$served" = "401" ] || fail "the plugin-launched server is not answering"

# The pane prints the pairing link; the token in it must work.
pane_link="$(herdr pane list | python3 -c '
import sys, json, subprocess
panes = json.load(sys.stdin)["result"]["panes"]
print(panes[-1]["pane_id"])
' | while read -r pane; do herdr pane read "$pane" --source visible --lines 40; done | sed -n "s/.*token=\([a-f0-9]\{64\}\).*/\1/p" | tail -1)"
[ -n "$pane_link" ] || fail "the serve pane did not print a pairing link"
code_plugin="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/state?token=$pane_link")"
echo "  plugin-launched server /api/state with its token → HTTP $code_plugin (expect 200)"
[ "$code_plugin" = "200" ] || fail "the pairing link printed in the pane does not authenticate"

herdr plugin action invoke herdr-mobile.web.status >/dev/null
sleep 2
herdr plugin log list --plugin herdr-mobile.web --limit 1 | python3 -c '
import sys, json
log = json.load(sys.stdin)["result"]["logs"][0]
assert log["exit_code"] == 0, "the status action failed: " + (log.get("stderr") or "")
print("  status action exit 0")
'

printf '\n\033[32mALL CHECKS PASSED\033[0m\n'
