#!/bin/bash
# Build Sightline.app into ~/Applications. Compiles the native window from app/src/main.swift.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/Sightline.app"

command -v swiftc >/dev/null || { echo "swiftc not found — install the Xcode command line tools"; exit 1; }

echo "compiling…"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -o "$APP/Contents/MacOS/Sightline" "$HERE/src/main.swift"

cp "$HERE/Info.plist"     "$APP/Contents/Info.plist"
cp "$HERE/Sightline.icns" "$APP/Contents/Resources/Sightline.icns"
chmod +x "$APP/Contents/MacOS/Sightline"

# Finder caches icons aggressively; touching the bundle makes it look again.
touch "$APP"
echo "installed: $APP"
