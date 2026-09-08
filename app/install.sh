#!/bin/bash
# Build Sightline.app into ~/Applications, so it can be launched from the icon rather than a
# terminal. Re-run after changing the launcher.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/Sightline.app"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$HERE/Info.plist"     "$APP/Contents/Info.plist"
cp "$HERE/launcher.sh"    "$APP/Contents/MacOS/Sightline"
cp "$HERE/Sightline.icns" "$APP/Contents/Resources/Sightline.icns"
chmod +x "$APP/Contents/MacOS/Sightline"

# Make Finder notice the icon changed.
touch "$APP"
echo "installed: $APP"
echo "The launcher expects this repo at: $(cd "$HERE/.." && pwd)"
