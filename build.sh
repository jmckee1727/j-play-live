#!/bin/sh
# Builds the Chrome Web Store package: a zip of exactly the files the extension needs.
# Usage: ./build.sh            -> dist/j-play-live-<version>.zip
set -e
cd "$(dirname "$0")"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
mkdir -p dist
OUT="dist/j-play-live-$VERSION.zip"
rm -f "$OUT"
zip -q -r "$OUT" \
    manifest.json background.js \
    archive.js clock.js audio.js judge.js wagers.js interpret.js reader.js names.js neural.js ear.js live.js \
    live.css stylecontent.css \
    icons/16.png icons/32.png icons/48.png icons/128.png \
    offscreen/tts.html offscreen/tts.js offscreen/ear.js \
    vendor/kokoro.web.js vendor/transformers.min.js vendor/ort-wasm-simd-threaded.jsep.mjs vendor/ort-wasm-simd-threaded.jsep.wasm \
    vendor/NOTICE.txt vendor/LICENSE-kokoro-js.txt vendor/LICENSE-transformers.txt vendor/LICENSE-phonemizer.txt vendor/LICENSE-onnxruntime.txt vendor/LICENSE-transformers-js.txt \
    sounds/README.txt \
    -x '*.DS_Store'
ls -la "$OUT"
echo "Upload $OUT at https://chrome.google.com/webstore/devconsole"
