#!/usr/bin/env bash
# Scan a Pokemon GO screen recording into a collection CSV.
#
# One command for the whole sequence usually composed by hand: ensure
# vendor/pvpoke exists (npm run setup), check the platform's frame/OCR
# tooling is reachable, then run scripts/scan-video.mjs.
#
# Usage:
#   scripts/scan.sh <video.mp4> [--out PATH] [scan-video.mjs flags...]
#
#   --out PATH   CSV output path (default: out/<video-basename>.csv)
#   --help       this text
#
# Any other flag (--interval, --no-level, --json, --quiet) is passed
# straight through to scripts/scan-video.mjs.
#
# Follow up with:  node scripts/verify.mjs out/<name>.csv <reference.csv>
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() { sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

video=""
out=""
passthrough=()
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --out) out="$2"; shift 2 ;;
    --*) passthrough+=("$1"); shift ;;
    *)
      if [ -n "$video" ]; then passthrough+=("$1"); shift; else video="$1"; shift; fi ;;
  esac
done

if [ -z "$video" ]; then usage; exit 2; fi
if [ ! -f "$video" ]; then echo "error: video not found: $video" >&2; exit 2; fi

# vendor/pvpoke is gitignored and absent on a fresh clone.
if [ ! -d "$repo/vendor/pvpoke" ]; then
  echo "[scan] vendor/pvpoke missing -- running npm run setup"
  (cd "$repo" && npm run setup)
fi

# Platform tooling check (see CLAUDE.md: macOS uses scan.swift, WSL2 uses
# ffmpeg + powershell.exe OCR, plain Linux is unsupported).
if [ "$(uname)" != "Darwin" ]; then
  command -v ffmpeg >/dev/null || { echo "error: ffmpeg not on PATH (required on WSL2)" >&2; exit 2; }
  command -v powershell.exe >/dev/null || { echo "error: powershell.exe not on PATH -- is this WSL2? Plain Linux is unsupported." >&2; exit 2; }
fi

if [ -z "$out" ]; then
  base="$(basename "$video")"
  out="out/${base%.*}.csv"
fi

cd "$repo"
node scripts/scan-video.mjs "$video" --out "$out" ${passthrough[@]+"${passthrough[@]}"}
echo "[scan] verify against a reference with: node scripts/verify.mjs \"$out\" <reference.csv>"
