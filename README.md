# Pokemon GO Video-to-CSV

<p align="center">
  <img alt="A screen recording swiping through appraised Pokemon" src="docs/appraisal-demo.gif" width="240">
</p>

That swipe becomes these rows:

<p align="center">
  <img alt="The resulting rows in the CSV" src="docs/csv-snippet.svg" width="480">
</p>

Node.js tool that turns a screen recording of your Pokemon GO box — the
appraisal screen, swiped from Pokemon to Pokemon — into a collection CSV
(`name,atk,def,sta,shadow,level,cp`). No Poke Genie export to keep up to
date, no manual data entry.

Originally built as the video importer for
[pogo-gbl-team-generator](https://github.com/Gidntsquia/pogo-gbl-team-generator),
which reads the CSV this produces and ranks the best GO Battle League teams
buildable from it.

## Quickstart 🚀

1. Take a screen recording of yourself swiping through your box with the
   **Appraise** panel open, resting about a second on each Pokemon.
2. Run this (requires Node ≥ 18, plus ffmpeg on Windows/WSL2 — see
   [Setup](https://github.com/Gidntsquia/pokemon-go-video-to-csv/wiki/Setup)):

```
git clone https://github.com/Gidntsquia/pokemon-go-video-to-csv
cd pokemon-go-video-to-csv
npm run setup                # downloads pvpoke's engine + data (required after every fresh clone)
scripts/scan.sh my-box.mp4   # scans to out/my-box.csv
```

Other common invocations:

```
node scripts/scan-video.mjs my-box.mp4 --out out/scanned.csv --interval 0.5
node scripts/verify.mjs out/scanned.csv reference.csv   # diff a scan against a hand-checked CSV
```

## Features 🔬

- Runs on macOS (AVFoundation + Vision) and Windows/WSL2 (ffmpeg + built-in
  Windows OCR) — no npm OCR dependency on either platform.
- Solves for the Pokemon's level and form rather than reading them directly,
  since the game never states either on screen.
- Detects shadow Pokemon from the sliver of the detail page peeking out
  above the appraisal panel, even though no caption or label names it.
- Settles each Pokemon's CP and IVs by voting across every frame it appears
  in, rather than trusting any single frame.
- Every row is checked against pvpoke's own CP/level math before being
  written; rows that don't check out are flagged as warnings, not silently
  written.
- Roughly half the length of the recording to scan.

## Documentation 📚

Detailed documentation is in the
[wiki](https://github.com/Gidntsquia/pokemon-go-video-to-csv/wiki):

- [Setup](https://github.com/Gidntsquia/pokemon-go-video-to-csv/wiki/Setup) — platform requirements, ffmpeg, Windows OCR
- [Recording and Reading](https://github.com/Gidntsquia/pokemon-go-video-to-csv/wiki/Recording-and-Reading) — how to record, what each CSV column is read from
- [How CP, Level, Form and Shadow Are Solved](https://github.com/Gidntsquia/pokemon-go-video-to-csv/wiki/How-CP-Level-Form-and-Shadow-Are-Solved) — the over-determined-stats trick, form solving, the shadow heuristic
- [Options](https://github.com/Gidntsquia/pokemon-go-video-to-csv/wiki/Options) — full `scan-video.mjs` flag list
- [How It Works](https://github.com/Gidntsquia/pokemon-go-video-to-csv/wiki/How-It-Works) — macOS vs. Windows/WSL2 architecture, code layout
- [Development and Tests](https://github.com/Gidntsquia/pokemon-go-video-to-csv/wiki/Development-and-Tests) — running `npm test`, what the fixtures cover
- [Known Limitations](https://github.com/Gidntsquia/pokemon-go-video-to-csv/wiki/Known-Limitations)
