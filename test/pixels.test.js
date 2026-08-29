// JavaScript Document
//
// Tests for the Windows half of the probe: pixels.js (the JS port of
// scan.swift's pixel encoder), raster.js, and probe-win.js's pure helpers.
// The contracts under test are the ones downstream code relies on -- above
// all that a row's runs tile its span with no holes, which is what lets
// bars.js measure a bar as a simple ratio.

import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzePixels } from '../src/videoscan/pixels.js';
import { brightGlyphs, cropRgb, inkGlyphs, resampleRgb } from '../src/videoscan/raster.js';
import { parseOcrLines, pickDimensions } from '../src/videoscan/probe-win.js';
import { countCpBoxes, readCp } from '../src/videoscan/text.js';

const WHITE = [252, 253, 252];
const FILL = [240, 165, 78];
const TRACK = [226, 226, 226];

function makeFrame(w, h, color) {
  const buf = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) buf.set(color, i * 3);
  return buf;
}

function paint(buf, w, x0, y0, x1, y1, color) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) buf.set(color, (y * w + x) * 3);
}

const FULL = { x: 0, y: 0, w: 1, h: 1 };

test('analyzePixels: a flat frame yields no rows', () => {
  const buf = makeFrame(200, 100, WHITE);
  const { rows } = analyzePixels(buf, 200, 100, { region: FULL });
  assert.deepEqual(rows, []);
});

test('analyzePixels: a bar row is emitted with runs that tile the region', () => {
  const buf = makeFrame(200, 100, WHITE);
  // A bar like GO draws it: fill next to track, card background either side.
  paint(buf, 200, 46, 20, 106, 30, FILL);
  paint(buf, 200, 106, 20, 180, 30, TRACK);

  const { rows } = analyzePixels(buf, 200, 100, { region: FULL });
  assert.equal(rows.length, 10);
  assert.deepEqual(
    rows.map((r) => r.y),
    Array.from({ length: 10 }, (_, i) => 20 + i)
  );
  const runs = rows[0].runs;
  assert.deepEqual(runs, [
    [0, 46, ...WHITE],
    [46, 60, ...FILL],
    [106, 74, ...TRACK],
    [180, 20, ...WHITE],
  ]);
  // The gapless-tiling contract bars.js depends on.
  let x = 0;
  for (const run of runs) {
    assert.equal(run[0], x);
    x += run[1];
  }
  assert.equal(x, 200);
});

test('analyzePixels: a hairline blip is absorbed and tiling survives', () => {
  const buf = makeFrame(200, 100, WHITE);
  paint(buf, 200, 46, 20, 106, 30, FILL);
  paint(buf, 200, 106, 20, 180, 30, TRACK);
  paint(buf, 200, 70, 25, 72, 26, [10, 10, 10]); // 2px of noise inside the fill

  const { rows } = analyzePixels(buf, 200, 100, { region: FULL });
  const noisy = rows.find((r) => r.y === 25);
  // The blip's pixels are credited to the fill run before it (two fill runs
  // remain -- scan.swift coalesces by owner, not colour -- but the blip's own
  // colour is gone and the tiling holds).
  assert.deepEqual(noisy.runs, [
    [0, 46, ...WHITE],
    [46, 26, ...FILL],
    [72, 34, ...FILL],
    [106, 74, ...TRACK],
    [180, 20, ...WHITE],
  ]);
  let x = 0;
  for (const run of noisy.runs) {
    assert.equal(run[0], x);
    x += run[1];
  }
  assert.equal(x, 200);
});

test('analyzePixels: two long runs without contrast are not a boundary', () => {
  const buf = makeFrame(200, 100, WHITE);
  // 252,253,252 next to 240,240,240: every channel within RUN_CONTRAST.
  paint(buf, 200, 0, 40, 100, 41, [240, 240, 240]);
  const { rows } = analyzePixels(buf, 200, 100, { region: FULL });
  assert.deepEqual(rows, []);
});

test('analyzePixels: strip rows and boxes come back as mean colours', () => {
  const buf = makeFrame(200, 100, WHITE);
  paint(buf, 200, 100, 0, 200, 3, [10, 20, 30]);
  paint(buf, 200, 100, 3, 200, 5, [200, 100, 50]);
  paint(buf, 200, 0, 50, 20, 60, [7, 8, 9]);

  const { strip, boxes } = analyzePixels(buf, 200, 100, {
    region: { x: 0, y: 0.9, w: 1, h: 0.1 },
    strip: { x: 0.5, y: 0, w: 0.5, h: 0.05 },
    boxes: [{ x: 0, y: 0.5, w: 0.1, h: 0.1 }],
  });
  assert.deepEqual(strip, [
    [10, 20, 30],
    [10, 20, 30],
    [10, 20, 30],
    [200, 100, 50],
    [200, 100, 50],
  ]);
  assert.deepEqual(boxes, [[7, 8, 9]]);
});

test('resampleRgb: scales toward the target width, both directions', () => {
  const same = makeFrame(10, 10, FILL);
  assert.equal(resampleRgb(same, 10, 10, 10).buf, same);

  const wide = makeFrame(100, 50, [10, 200, 30]);
  const down = resampleRgb(wide, 100, 50, 50);
  assert.equal(down.w, 50);
  assert.equal(down.h, 25);
  for (let i = 0; i < down.w * down.h; i++) {
    assert.deepEqual([...down.buf.subarray(i * 3, i * 3 + 3)], [10, 200, 30]);
  }

  const up = resampleRgb(makeFrame(10, 20, FILL), 10, 20, 30);
  assert.equal(up.w, 30);
  assert.equal(up.h, 60);
  assert.deepEqual([...up.buf.subarray(0, 3)], FILL);

  // The Windows OCR height cap binds even when the width already fits.
  const tall = resampleRgb(makeFrame(10, 100, WHITE), 10, 100, 20, 50);
  assert.equal(tall.w, 5);
  assert.equal(tall.h, 50);
});

test('cropRgb: cuts the normalized rect out of the frame', () => {
  const buf = makeFrame(20, 10, WHITE);
  paint(buf, 20, 10, 5, 20, 10, FILL);
  const cut = cropRgb(buf, 20, 10, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  assert.equal(cut.w, 10);
  assert.equal(cut.h, 5);
  for (let i = 0; i < cut.w * cut.h; i++) {
    assert.deepEqual([...cut.buf.subarray(i * 3, i * 3 + 3)], FILL);
  }
});

test('inkGlyphs: faint glyphs on a veiled card become black on white', () => {
  // Cream background with grey capitals, like the badge band under the veil.
  const buf = makeFrame(50, 10, [238, 234, 216]);
  paint(buf, 50, 5, 3, 15, 7, [170, 170, 166]);
  const ink = inkGlyphs(buf);
  assert.equal(ink.length, 50 * 10);
  assert.equal(ink[3 * 50 + 5], 0);
  assert.equal(ink[0], 255);
});

test('readCp accepts the "01498" misread of the stylized CP prefix', () => {
  assert.equal(readCp([{ x: 0, y: 0.05, w: 0.2, h: 0.03, c: 1, s: '01498' }]), 1498);
  assert.equal(countCpBoxes([{ x: 0, y: 0.05, w: 0.2, h: 0.03, c: 1, s: '01498' }]), 1);
  // A genuine CP box still wins by position, and plain numbers stay ignored.
  assert.equal(readCp([{ x: 0, y: 0.3, w: 0.2, h: 0.03, c: 1, s: '363' }]), undefined);
  assert.equal(readCp([{ x: 0, y: 0.3, w: 0.2, h: 0.03, c: 1, s: '22.43' }]), undefined);
  // The misread pattern only counts where the CP is drawn, and needs 3+
  // digits -- "067" off a weight line must not become a CP vote.
  assert.equal(readCp([{ x: 0, y: 0.5, w: 0.2, h: 0.03, c: 1, s: '0678' }]), undefined);
  assert.equal(readCp([{ x: 0, y: 0.05, w: 0.2, h: 0.03, c: 1, s: '067' }]), undefined);
  assert.equal(readCp([{ x: 0, y: 0.05, w: 0.2, h: 0.03, c: 1, s: 'O968' }]), 968);
});

test('brightGlyphs: only near-white pixels become glyphs', () => {
  // Sky-blue scene, white CP text, the yellow buddy star, a black clock.
  const buf = makeFrame(40, 10, [120, 180, 230]);
  paint(buf, 40, 5, 3, 15, 7, [250, 251, 250]); // CP text
  paint(buf, 40, 20, 3, 25, 7, [250, 220, 90]); // star: bright but not white
  paint(buf, 40, 30, 3, 35, 7, [20, 20, 20]); // clock
  const ink = brightGlyphs(buf);
  assert.equal(ink.length, 40 * 10);
  assert.equal(ink[5 * 40 + 5], 0);
  assert.equal(ink[5 * 40 + 22], 255);
  assert.equal(ink[5 * 40 + 32], 255);
  assert.equal(ink[0], 255);
});

test('pickDimensions: honours rotation metadata the way ffmpeg will', () => {
  assert.deepEqual(pickDimensions({ streams: [{ width: 1206, height: 2622 }] }), { w: 1206, h: 2622 });
  assert.deepEqual(
    pickDimensions({ streams: [{ width: 2622, height: 1206, side_data_list: [{ rotation: -90 }] }] }),
    { w: 1206, h: 2622 }
  );
  assert.deepEqual(
    pickDimensions({ streams: [{ width: 2622, height: 1206, tags: { rotate: '90' } }] }),
    { w: 1206, h: 2622 }
  );
  assert.throws(() => pickDimensions({ streams: [] }), /no video track/);
});

test('parseOcrLines: normalizes pixel rects by the OCR image size', () => {
  const boxes = parseOcrLines(
    { lines: [{ s: 'CP 1498', x: 50, y: 10, w: 100, h: 20 }] },
    1000,
    2000
  );
  assert.deepEqual(boxes, [{ x: 0.05, y: 0.005, w: 0.1, h: 0.01, c: 1, s: 'CP 1498' }]);
  assert.deepEqual(parseOcrLines({ lines: [] }, 100, 100), []);
  assert.throws(() => parseOcrLines({ error: 'boom' }, 100, 100), /Windows OCR failed: boom/);
});
