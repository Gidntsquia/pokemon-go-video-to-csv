// JavaScript Document
//
// Reads the type badges as *colour*, for the frames where OCR cannot read
// them as text.
//
// The badge row under the HP line is a colored circle per type with the type
// name beside it, and the trainer avatar stands over the right-hand end of
// the row -- which is exactly where a second type's name goes. So for the
// species whose forms share a first type (a Galarian Stunfisk is GROUND/steel
// where a plain one is GROUND/electric), the one thing on screen that names
// the form is a circle whose text is behind the avatar. The circle itself
// usually still shows, and steel is teal where electric is yellow.
//
// The row is sampled as a strip of small mean-colour boxes (probe.js's
// BADGE_TILES) so both platform probes stay generic. The appraisal panel's
// cream veil dims the whole row, so every tile is first normalized against a
// reference tile of bare card from the same frame -- the same
// compare-two-places-on-one-frame trick aura.js and purify.js use.
//
// The palette below was measured off real recordings (veil-normalized,
// 0-255); fighting and dark's neighbours sit close to normal's grey, which
// is why classify() demands a clear margin before it names a type at all.

/** Veil-normalized badge circle colours, measured on IMG_7216/7217. */
const BADGE_COLORS = {
  normal: [192, 196, 188],
  fire: [254, 202, 143],
  water: [165, 203, 227],
  electric: [249, 235, 155],
  grass: [201, 231, 191],
  ice: [199, 235, 224],
  fighting: [216, 152, 130], // approximate; not yet seen in a recording
  poison: [200, 162, 206],
  ground: [226, 186, 150],
  flying: [195, 200, 213],
  psychic: [244, 171, 158],
  bug: [198, 222, 129],
  rock: [211, 200, 159],
  ghost: [154, 164, 199],
  dragon: [140, 176, 196],
  dark: [169, 169, 166],
  steel: [166, 187, 180],
  fairy: [228, 187, 209],
};

/** A tile this close to bare card is card, not circle. */
const CARD_MIN_DISTANCE = 30;
/**
 * A run whose deepest tile is still this close to card is *something* -- a
 * badge's small grey label text averages into the tiles as a faint warm
 * tint around depth 50 -- but not a badge circle: measured across every
 * recorded card, no real circle's deepest tile came in under 78. Such a run
 * classifies as unknown, which excludes nothing, rather than as a faint
 * match for everything pale.
 */
const CIRCLE_MIN_DEPTH = 65;
/**
 * How much of a palette colour's depth a sampled tile may keep and still be
 * that colour. A tile's mean always mixes some card white in around the
 * circle, which SCALES the absorption vector down without turning it; it can
 * never deepen it, which is what separates a pale dragon indigo from water
 * blue -- the two point the same way and differ only in depth.
 */
const SCALE_RANGE = [0.6, 1.25];

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Read the badge circles visible in one frame's badge tiles, as one
 * plausible-type set per circle.
 *
 * A set rather than a verdict, because what the form question needs is
 * exclusion: the teal circle beside a Stunfisk's GROUND badge does not have
 * to be provably steel, it has to be provably not electric. index.js asks
 * whether any of a circle's plausible types fits a candidate form; a circle
 * that matches nothing at all (the avatar's hair crossing the row) comes
 * back as an empty set and excludes nothing.
 *
 * @param {number[][]} [boxes] - probe.js box means: AURA_BOXES first, then
 *   one reference tile of bare card, then the badge-row tiles left to right.
 * @param {number} auraCount - how many leading boxes belong to aura.js.
 * @returns {string[][]|undefined} per circle, left to right, the types it
 *   could be; undefined when the frame carries no badge tiles (recordings
 *   made before they existed).
 */
export function readBadgeColors(boxes, auraCount = 4) {
  if (!Array.isArray(boxes) || boxes.length < auraCount + 3) return undefined;
  const ref = boxes[auraCount];
  const tiles = boxes.slice(auraCount + 1);
  if (!ref || ref[0] < 150) return undefined; // reference is not bare card

  const normalized = tiles.map((t) =>
    [0, 1, 2].map((i) => Math.min(255, Math.round((255 * t[i]) / Math.max(1, ref[i]))))
  );

  // A circle spans two or three adjacent tiles; take each connected run of
  // non-card tiles as one circle and classify its most saturated tile --
  // the one nearest the circle's centre, where the least card bleeds into
  // the mean.
  const found = [];
  let run = null;
  const flush = () => {
    if (run) found.push(classify(run.color));
    run = null;
  };
  for (const color of normalized) {
    const off = dist(color, [255, 255, 255]);
    if (off < CARD_MIN_DISTANCE) {
      flush();
      continue;
    }
    if (!run) run = { color, off };
    else if (off > run.off) Object.assign(run, { color, off });
  }
  flush();
  return found;
}

/**
 * Every palette entry a circle colour could plausibly be, best match first.
 *
 * Matching happens on absorption vectors (255 minus each channel), because
 * card white bleeding into a tile's mean scales that vector without turning
 * it: each palette entry is tried as "this colour, diluted", and scored by
 * what dilution cannot explain. The scale is clamped because dilution only
 * ever weakens -- a pale dragon indigo and water blue point the same way
 * and differ only in depth.
 *
 * @param {number[]} color - veil-normalized [r, g, b].
 * @returns {string[]} empty when nothing on the palette is close.
 */
export function classify(color) {
  const v = color.map((c) => 255 - c);
  const depth = Math.hypot(...v);
  if (depth < CIRCLE_MIN_DEPTH) return [];

  const accept = Math.max(22, 0.2 * depth);
  return Object.entries(BADGE_COLORS)
    .map(([type, c]) => {
      const p = c.map((x) => 255 - x);
      const raw = (v[0] * p[0] + v[1] * p[1] + v[2] * p[2]) / (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
      const a = Math.max(SCALE_RANGE[0], Math.min(SCALE_RANGE[1], raw));
      return { type, d: dist(v, p.map((x) => x * a)) };
    })
    .filter((r) => r.d <= accept)
    .sort((x, y) => x.d - y.d)
    .map((r) => r.type);
}
