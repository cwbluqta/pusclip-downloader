#!/usr/bin/env bash
set -euo pipefail

if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y yt-dlp ffmpeg
  exit 0
fi

if command -v apk >/dev/null 2>&1; then
  sudo apk add --no-cache yt-dlp ffmpeg
  exit 0
fi

if command -v brew >/dev/null 2>&1; then
  brew install yt-dlp ffmpeg
  exit 0
fi

cat <<'MSG'
No supported package manager found.
Install manually:
- yt-dlp: https://github.com/yt-dlp/yt-dlp/wiki/Installation
- ffmpeg: https://ffmpeg.org/download.html
MSG
exit 1
