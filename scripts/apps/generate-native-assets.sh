#!/usr/bin/env bash
#
# Regenerates every iOS / Android icon + splash PNG that the Capacitor
# projects reference, from the brand sources in assets/:
#
#   assets/icon-only.png       1024x1024 opaque app icon (navy, reversed mark)
#   assets/icon-foreground.png 1024x1024 transparent mark (adaptive-icon layer)
#   assets/splash.png          2732x2732 launch screen
#
# The script reads each placeholder's dimensions from the native projects and
# re-renders that exact size, so it stays correct after `npx cap add` or a
# Capacitor upgrade. Requires ImageMagick (`convert`).
#
#   ./scripts/apps/generate-native-assets.sh
#
set -euo pipefail
cd "$(dirname "$0")/../.."

ICON=assets/icon-only.png
FOREGROUND=assets/icon-foreground.png
SPLASH=assets/splash.png

if ! command -v convert >/dev/null 2>&1; then
  echo "error: ImageMagick 'convert' is required (brew install imagemagick / apt install imagemagick)" >&2
  exit 1
fi

for src in "$ICON" "$FOREGROUND" "$SPLASH"; do
  [ -f "$src" ] || { echo "error: missing $src" >&2; exit 1; }
done

# render <source> <target> <fit|cover>
#   fit   — scale to the target's exact size (square icons, foreground layer)
#   cover — scale + centre-crop to fill (splash screens of any aspect ratio)
render() {
  local src=$1 target=$2 mode=$3 dims
  dims=$(identify -format '%wx%h' "$target")
  case "$mode" in
    cover) convert "$src" -strip -resize "${dims}^" -gravity center -extent "$dims" "$target" ;;
    fit)   convert "$src" -strip -resize "$dims" "$target" ;;
    *)     echo "error: unknown mode $mode" >&2; exit 1 ;;
  esac
  echo "  $(printf '%-9s' "$dims") $target"
}

count=0
while IFS= read -r file; do
  case "$(basename "$file")" in
    ic_launcher.png | ic_launcher_round.png | AppIcon-512@2x.png)
      render "$ICON" "$file" fit; count=$((count + 1)) ;;
    ic_launcher_foreground.png)
      render "$FOREGROUND" "$file" fit; count=$((count + 1)) ;;
    splash.png | splash-*.png)
      render "$SPLASH" "$file" cover; count=$((count + 1)) ;;
  esac
done < <(find ios/App/App/Assets.xcassets android/app/src/main/res -name '*.png' 2>/dev/null | sort)

echo "Regenerated $count native assets from assets/."
