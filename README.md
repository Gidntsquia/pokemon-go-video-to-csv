# Pokemon GO Video-to-CSV

Turn a screen recording of your Pokemon GO box — the appraisal screen, swiped
from Pokemon to Pokemon — into a collection CSV
(`name,atk,def,sta,shadow,level,cp`). No Poke Genie export to keep up to
date, no manual data entry.

**macOS only.** Frame decoding is AVFoundation and text recognition is
Apple's Vision framework, both macOS system frameworks — no npm dependency,
no ffmpeg, no OCR install.

Originally built as the video importer for
[pogo-gbl-team-generator](https://github.com/Gidntsquia/pogo-gbl-team-generator),
which reads the CSV this produces and ranks the best GO Battle League teams
buildable from it.

## Setup

Requires Node ≥ 18 and the Xcode Command Line Tools
(`xcode-select --install`).

```bash
npm run setup   # or: bash scripts/setup.sh
```

This clones a pinned, read-only, sparse copy of [pvpoke](https://pvpoke.com)'s
engine and data into `vendor/pvpoke` (gitignored — required after every fresh
clone; there are no npm dependencies to install). The scanner executes
pvpoke's own CP/level math to verify every row it writes — nothing about the
game's stat formulas is reimplemented here.

## Usage

```bash
node scripts/scan-video.mjs my-box.mp4 --out out/scanned.csv
```

**How to record.** Open a Pokemon, tap **Appraise** so the three stat bars
are showing, then swipe through your box resting about a second on each
Pokemon. AirDrop the recording to your Mac. Frames caught mid-swipe are
thrown away on purpose, which is why the pause matters.

Two things the game does make this harder than it sounds, and the scanner
handles both rather than trusting any single frame:

- **The Pokemon is drawn over its own CP.** A wing or a flame crossing the
  digits makes the number read short (`968` comes back as `96`). So CP is
  settled per Pokemon rather than per frame: max HP is printed inside the
  white card where nothing covers it, and species + IVs + HP narrow the CP to
  a short list — usually one. A CP recovered that way is always reported as a
  warning, never written silently.
- **The appraisal bars animate in.** The first frame or two after a swipe
  genuinely shows shorter bars than the real IVs, so the frames of one
  Pokemon vote and the settled reading wins.

**What it reads, and from where:**

| Column | Read from |
| --- | --- |
| `cp` | the large `CP 1498` text above the Pokemon |
| `name` | the caught-location caption — *"This **Trevenant** was caught on…"* |
| `atk` / `def` / `sta` | the three appraisal bars, measured in pixels |
| `level` | not shown on screen — solved for from species + IVs + CP + max HP |
| `shadow` | the sliver of `PURIFY` / `POWER UP` button above the panel, or failing that the purple aura |
| the *form* | not stated anywhere — settled from CP + max HP + IVs, then the type badges |

A Pokemon is identified across frames by species + max HP, so two of the same
species scan as two rows as long as their HP differs.

The species deliberately comes from the caption rather than the name above
the stats, because that name is your own **nickname** — for most PvP players
it's a rank percentage ("Trevena91.1"), not a species.

Because CP, max HP and the three IVs over-determine each other, every row is
checked before it is written: if no level in the game's range produces the
CP *and* the HP that were read, the scan misread something and the row is
flagged as a warning instead of quietly landing in your CSV.

**Forms.** The caption gives the base species and nothing else: a Galarian
Corsola says *"This **Corsola** was caught on…"* just like an ordinary one,
and species the game only has forms of (Oricorio, Lycanroc, Morpeko) used to
be dropped entirely. So the form is *solved for* the same way the level is —
by asking which form has a level that produces the CP and the max HP that
were read. Usually exactly one does: a Corsola with 101 HP and 13/10/15 is
Galarian at level 20, and an ordinary one is nothing at all.

**Shadow.** No text on the appraisal screen says it. The caption gives the
base species with no "Shadow" in front of it, the name above the stats is
your own nickname, and the purple flames are a picture rather than a word.
Pokemon GO writes it down on the detail page *behind* the panel — the
`PURIFY` button and the `SHADOW BONUS` note under the moves — and those
frames have no bars and no caption to read either. The scan picks the marker
off them anyway and ties it back to a Pokemon by the CP and max HP still on
screen, so swiping with the panel shut once per Pokemon still works.

It is no longer necessary, though, because the panel does not quite cover the
page behind it. Two things show above its top edge:

- **The action button.** A shadow Pokemon's page has `PURIFY` above `POWER
  UP`; an ordinary one has only `POWER UP`. Either way the topmost of the two
  lands a few pixels above the panel — pink for `PURIFY`, green for `POWER
  UP`. There is no legible text left at that size, so it is read as colour,
  and always as a *difference* from the bare veil just above it rather than
  as an absolute (the panel's cream wash varies from card to card). This is
  the Pokemon's own page stating the fact, so it is never overruled. It
  answers for roughly two Pokemon in three; on the rest the page happens to
  be scrolled far enough that the buttons sit under the panel.
- **The aura.** For those, the purple smoke around the Pokemon decides.
  None of what makes the aura obvious to a person survives on its own — GO's
  backgrounds cycle through purple, navy and tan, half of them are dark, and
  several are animated — but the aura is *local*: on an ordinary card the
  background beside the Pokemon's feet matches the background under the CP
  text, and the aura darkens it and pushes it blue in only one of those two
  places. Measured against the 257 Pokemon in the test recordings whose
  button *could* be read, and which therefore have an answer that does not
  come from the aura, the rule gets all 26 shadows and none of the 231
  ordinary Pokemon — including a violet Sableye on near-black and a Hisuian
  Braviary lit magenta from behind. Of the 136 it then answered for on its
  own, one had to be corrected by hand, and the rule was tightened until it
  got that one too.

The scan says which of the two answered for how many, and names the ones the
aura called shadow: that half is a strong resemblance rather than a stated
fact, and it is the half worth a second look.

When two forms are stat-for-stat identical the type badges under the HP text
break the tie — that is the only thing separating Oricorio's four dance
forms, which differ solely by type. And when even that cannot (Morpeko's two
forms; a Galarian Stunfisk, whose *"GROUND"* badge Vision reads without the
*"STEEL"* one beside it) the row is written as the form Pokemon GO stores by
default **and says so in a warning**, so those are the rows worth a glance.

## Options

```
node scripts/scan-video.mjs <video.mp4> [options]
  --out PATH      CSV output path                 (default out/scanned.csv)
  --interval S    seconds between sampled frames  (default 0.25)
  --no-level      skip level derivation (faster; leaves the level column blank)
  --json PATH     also write the full per-Pokemon detail as JSON
  --quiet         only print the summary line
```

Roughly half the length of the recording: a 28-second clip of 15 Pokemon
scans in about 14 seconds.

## How it works

The only non-JS piece is the small `src/videoscan/scan.swift` helper, which
decodes frames (AVFoundation) and reads text and pixel regions (Vision). It
is compiled once into `out/.videoscan/` and reused (an unoptimized script
run is ~5x slower, since it measures every pixel of every sampled frame).
Everything it doesn't do — deciding what a frame shows, measuring the bars,
grouping frames into Pokemon, solving levels and forms — is plain JavaScript
in `src/videoscan/`, unit-tested against recorded frames in
`fixtures/videoscan/`.

- `src/videoscan/` — the scanner: frame classification, bar measurement,
  caption → species resolution, shadow detection, grouping, level/form
  solving, CSV output.
- `src/importer/gamemaster.js` — resolves species names against pvpoke's
  gamemaster.
- `src/engine/` — boots pvpoke's own code headlessly in a Node `vm`; the
  level derivation runs pvpoke's `calculateCP`/`getCPMByLevel` against the
  vendored gamemaster.
- `vendor/pvpoke` — pinned sparse clone (gitignored, created by
  `scripts/setup.sh`); read-only, never edited.

## Tests

```bash
npm test
```

`test/videoscan.test.js` covers the scanner against real frames recorded off
a phone — `fixtures/videoscan/appraisal-frames.jsonl` (a downscaled clip)
and `ultra-frames.jsonl` (full resolution, including a maxed stat drawn in
red, a CP behind the Pokemon's animation, and a frame caught while the bars
were still filling) — so the tests need no video and no macOS frameworks to
run (they work on Linux; only the actual video scan is macOS-only). The
level-derivation tests boot the vendored pvpoke engine, so `npm run setup`
must have been run first.

## Known limitations

- macOS-only (AVFoundation + Vision); the recording needs the appraisal
  panel visible.
- Cannot see a Pokemon's moves, Lucky or Best Buddy status. Shadow it does
  read, from the sliver of page above the panel (see "Shadow" above).
