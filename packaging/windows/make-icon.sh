#!/bin/sh
# Regenerate packaging/windows/teamclaude.ico from the mark in src/logo.js.
# Needs node, rsvg-convert and icotool (Debian: apt-get install librsvg2-bin
# icoutils). Run from the repository root after the mark changes, and commit
# the result: the installer build uses the committed file.
set -eu
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
node --input-type=module -e "import { LOGO_SVG } from './src/logo.js'; process.stdout.write(LOGO_SVG)" > "$tmp/logo.svg"
for size in 16 24 32 48 64 256; do
  rsvg-convert -w "$size" -h "$size" "$tmp/logo.svg" -o "$tmp/$size.png"
done
# The 256px image is stored as PNG (-r), as Windows reads it; as a bitmap it
# would be most of the file.
icotool -c -o packaging/windows/teamclaude.ico "$tmp"/16.png "$tmp"/24.png "$tmp"/32.png "$tmp"/48.png "$tmp"/64.png -r "$tmp"/256.png
