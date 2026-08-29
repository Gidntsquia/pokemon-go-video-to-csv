// JavaScript Document
//
// Pixel analyser for the Windows probe (probe-win.js): a line-for-line port
// of the pixel half of scan.swift, over a raw RGB24 frame buffer instead of
// a CVPixelBuffer. It produces the same three summaries the Swift helper
// emits -- run-length-encoded `rows`, per-row `strip` means, and per-box
// mean colours -- with the same tuning constants, so bars.js, purify.js and
// aura.js read a Windows-decoded frame exactly as they read a macOS one.
//
// Keep this file and scan.swift's constants in lockstep: they were measured
// together, and the fixtures under fixtures/videoscan/ record the Swift
// side's output.

// Two pixels belong to the same run when every channel is within this of the
// run's first pixel. Large enough to survive video compression noise on a
// flat UI fill, small enough that an orange->grey bar boundary always splits.
export const COLOR_TOLERANCE = 10;
// A row is emitted only if it holds two runs at least this fraction of the
// region wide whose colours clearly differ. That is exactly the shape of a
// progress-bar row (filled part next to empty track, or bar next to card
// background) and it rejects flat backgrounds, text lines, and artwork.
export const MIN_RUN_FRACTION = 0.06;
// How far apart two long runs must be, on any one channel, to count as a
// colour boundary rather than compression drift across a gradient.
export const RUN_CONTRAST = 18;
// Rows this fragmented are photographic content, never flat UI.
export const MAX_RUNS_PER_ROW = 120;
// Runs shorter than this are anti-aliasing, glyph strokes, and photo noise.
// They are absorbed into whichever neighbouring run they are closer to in
// colour, so the emitted runs still tile the region with no gaps -- that
// gapless coverage is what lets bars.js measure a bar by simple ratio.
export const MIN_EMIT_RUN = 4;
// Two long runs only read as a bar boundary if they are adjacent -- at most
// this many pixels of anything in between.
export const MAX_BOUNDARY_GAP = 6;

/** @typedef {[number, number, number, number, number]} Run [x, length, r, g, b] */

/**
 * Clamp a normalized rect to pixel bounds the way scan.swift does: origin
 * truncated and held inside the frame, far edge at least one pixel on.
 */
function clampRect(rect, w, h) {
  const x0 = Math.max(0, Math.min(w - 1, Math.trunc(rect.x * w)));
  const y0 = Math.max(0, Math.min(h - 1, Math.trunc(rect.y * h)));
  const x1 = Math.max(x0 + 1, Math.min(w, Math.trunc((rect.x + rect.w) * w)));
  const y1 = Math.max(y0 + 1, Math.min(h, Math.trunc((rect.y + rect.h) * h)));
  return { x0, y0, x1, y1 };
}

/**
 * Collapse sub-MIN_EMIT_RUN runs into the neighbouring run they most
 * resemble, then coalesce touching same-owner runs. Output tiles the same
 * x span as the input with no holes.
 *
 * @param {Run[]} runs
 * @returns {Run[]}
 */
export function absorbShortRuns(runs) {
  if (runs.length <= 1) return runs;
  if (!runs.some((r) => r[1] >= MIN_EMIT_RUN)) return runs;

  const dist = (a, b) => Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]) + Math.abs(a[4] - b[4]);

  // owner[i] = index of the long run each run's pixels are credited to.
  const nextLongFor = new Array(runs.length).fill(-1);
  let seen = -1;
  for (let i = runs.length - 1; i >= 0; i--) {
    nextLongFor[i] = seen;
    if (runs[i][1] >= MIN_EMIT_RUN) seen = i;
  }
  const owner = new Array(runs.length).fill(0);
  let prevLong = -1;
  for (let i = 0; i < runs.length; i++) {
    if (runs[i][1] >= MIN_EMIT_RUN) {
      owner[i] = i;
      prevLong = i;
      continue;
    }
    const nxt = nextLongFor[i];
    if (prevLong >= 0 && nxt >= 0) owner[i] = dist(runs[i], runs[prevLong]) <= dist(runs[i], runs[nxt]) ? prevLong : nxt;
    else if (prevLong >= 0) owner[i] = prevLong;
    else if (nxt >= 0) owner[i] = nxt;
    else owner[i] = i;
  }

  /** @type {Run[]} */
  const out = [];
  let current = -1;
  for (let i = 0; i < runs.length; i++) {
    if (current === owner[i] && out.length > 0) {
      out[out.length - 1][1] += runs[i][1];
    } else {
      const o = runs[owner[i]];
      out.push([runs[i][0], runs[i][1], o[2], o[3], o[4]]);
      current = owner[i];
    }
  }
  return out;
}

/**
 * Run-length encode one row of the region, returning `null` when the row
 * holds nothing bar-like (see MIN_RUN_FRACTION).
 *
 * @param {Uint8Array} buf - RGB24 frame, rows top-down.
 * @param {number} w - frame width in pixels.
 * @param {number} y
 * @param {number} x0
 * @param {number} x1
 * @param {number} minRunLen
 * @returns {{y: number, runs: Run[]}|null}
 */
export function encodeRow(buf, w, y, x0, x1, minRunLen) {
  /** @type {Run[]} */
  const runs = [];
  let startX = x0;
  let sr = 0, sg = 0, sb = 0;
  let first = true;

  for (let x = x0; x < x1; x++) {
    const o = (y * w + x) * 3;
    const r = buf[o], g = buf[o + 1], b = buf[o + 2];
    if (first) {
      sr = r; sg = g; sb = b;
      startX = x;
      first = false;
      continue;
    }
    if (Math.abs(r - sr) > COLOR_TOLERANCE || Math.abs(g - sg) > COLOR_TOLERANCE || Math.abs(b - sb) > COLOR_TOLERANCE) {
      if (x - startX > 0) runs.push([startX, x - startX, sr, sg, sb]);
      sr = r; sg = g; sb = b;
      startX = x;
    }
  }
  if (x1 - startX > 0 && !first) runs.push([startX, x1 - startX, sr, sg, sb]);

  // Does this row contain a bar boundary: two wide flat runs of clearly
  // different colour, separated by at most a hairline?
  let boundary = false;
  outer: for (let i = 0; i < runs.length; i++) {
    if (runs[i][1] < minRunLen) continue;
    let gap = 0;
    for (let j = i + 1; j < runs.length; j++) {
      if (runs[j][1] >= minRunLen) {
        const a = runs[i], b = runs[j];
        if (
          Math.abs(a[2] - b[2]) >= RUN_CONTRAST ||
          Math.abs(a[3] - b[3]) >= RUN_CONTRAST ||
          Math.abs(a[4] - b[4]) >= RUN_CONTRAST
        ) {
          boundary = true;
          break outer;
        }
        break;
      }
      gap += runs[j][1];
      if (gap > MAX_BOUNDARY_GAP) break;
    }
  }
  if (!boundary) return null;

  const kept = absorbShortRuns(runs);
  if (kept.length > MAX_RUNS_PER_ROW) return null;
  return { y, runs: kept };
}

/**
 * Analyse one decoded frame the way scan.swift does, over the same
 * normalized top-left-origin rects probe.js passes it.
 *
 * @param {Uint8Array} buf - RGB24 pixels, rows top-down, (y*w+x)*3.
 * @param {number} w
 * @param {number} h
 * @param {{region: {x:number,y:number,w:number,h:number},
 *   strip?: {x:number,y:number,w:number,h:number},
 *   boxes?: {x:number,y:number,w:number,h:number}[]}} rects
 * @returns {{rows: {y:number, runs: Run[]}[], strip: number[][], boxes: number[][]}}
 */
export function analyzePixels(buf, w, h, { region, strip, boxes = [] }) {
  const r = clampRect(region, w, h);
  const minRunLen = Math.max(4, Math.trunc(MIN_RUN_FRACTION * (r.x1 - r.x0)));

  const rows = [];
  for (let y = r.y0; y < r.y1; y++) {
    const row = encodeRow(buf, w, y, r.x0, r.x1, minRunLen);
    if (row) rows.push(row);
  }

  const stripOut = [];
  if (strip) {
    const s = clampRect(strip, w, h);
    const width = s.x1 - s.x0;
    for (let y = s.y0; y < s.y1; y++) {
      let sr = 0, sg = 0, sb = 0;
      for (let x = s.x0; x < s.x1; x++) {
        const o = (y * w + x) * 3;
        sr += buf[o]; sg += buf[o + 1]; sb += buf[o + 2];
      }
      stripOut.push([Math.trunc(sr / width), Math.trunc(sg / width), Math.trunc(sb / width)]);
    }
  }

  const boxesOut = boxes.map((box) => {
    const b = clampRect(box, w, h);
    let sr = 0, sg = 0, sb = 0;
    for (let y = b.y0; y < b.y1; y++) {
      for (let x = b.x0; x < b.x1; x++) {
        const o = (y * w + x) * 3;
        sr += buf[o]; sg += buf[o + 1]; sb += buf[o + 2];
      }
    }
    const n = (b.x1 - b.x0) * (b.y1 - b.y0);
    return [Math.trunc(sr / n), Math.trunc(sg / n), Math.trunc(sb / n)];
  });

  return { rows, strip: stripOut, boxes: boxesOut };
}
