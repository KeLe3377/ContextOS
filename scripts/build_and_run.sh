#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="ContextOS"
APP_PROCESS="ContextOS"
BUNDLE_ID="dev.corey.wake"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/dist/$APP_NAME.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/$APP_PROCESS"

pkill -x "$APP_PROCESS" >/dev/null 2>&1 || true
for _ in {1..30}; do
  if ! pgrep -x "$APP_PROCESS" >/dev/null; then
    break
  fi
  sleep 0.1
done
"$ROOT_DIR/scripts/make-app.sh"
# Launch Services may still be refreshing the just-replaced, re-signed bundle.
sleep 0.5

open_app() {
  /usr/bin/open "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_PROCESS\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    for _ in {1..20}; do
      if pgrep -x "$APP_PROCESS" >/dev/null; then
        break
      fi
      sleep 0.25
    done
    pgrep -x "$APP_PROCESS" >/dev/null
    echo "✓ $APP_NAME 正在运行"
    ;;
  *)
    echo "用法：$0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
