# Pokemon GO Video-to-CSV

Turns a screen recording of a Pokemon GO box (appraisal screen, swiped
Pokemon to Pokemon) into a collection CSV. Extracted from
pogo-gbl-team-generator, which consumes the CSV.

## Commands

- `npm run setup` — clones a pinned sparse copy of pvpoke into
  `vendor/pvpoke` (gitignored). Required after every fresh clone; there are
  no npm dependencies to install.
- `npm run scan -- my-box.mp4 --out out/scanned.csv` — run the scanner
- `npm test` — `node --test test/*.test.js`

## Layout

- `scripts/scan-video.mjs` — CLI entry point
- `src/videoscan/` — frame OCR parsing and per-Pokemon vote/settle logic
- `src/importer/` — gamemaster/species data from vendored pvpoke
- `src/engine/` — loads and executes pvpoke's CP/level math

## Gotchas

- Scanning runs on macOS (scan.swift: AVFoundation + Vision) and on
  Windows/WSL2 (probe-win.js: ffmpeg + built-in Windows OCR via
  powershell.exe). Plain Linux is unsupported. This dev machine is WSL2, so
  the scanner runs here once ffmpeg is on the PATH.
- pixels.js is a line-for-line port of scan.swift's pixel encoder; if a
  tuning constant changes in one, change it in the other.
- CP/level math is executed from vendored pvpoke code, never reimplemented.
  Don't add stat formulas to `src/`.
- `src/` and `test/` load data from `vendor/pvpoke`, so `npm run setup`
  must have been run before tests pass.
