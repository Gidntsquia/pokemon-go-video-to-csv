// JavaScript Document
//
// Small raster utilities for the Windows probe (probe-win.js): resizing a
// frame for OCR and cropping and binarizing the type-badge band. The
// binarizers emit Gray8 -- one byte per pixel -- because that is what
// ocr.ps1 ships to Windows.Media.Ocr, and a quarter the bytes of BGRA is
// noticeably less base64 down a pipe. Pure buffer math, no platform.

/**
 * Bilinear-resample an RGB24 frame to `targetW` wide -- up or down, because
 * Windows OCR needs both: a full-resolution recording is shrunk for speed,
 * and a downscaled one is enlarged or its glyphs drop below what the engine
 * can read at all (a 384-wide clip loses whole digits). `maxH` caps the
 * result under Windows OCR's hard image-dimension limit. Returns the input
 * untouched when it is already the target size.
 *
 * @param {Uint8Array} buf - RGB24, rows top-down.
 * @param {number} w
 * @param {number} h
 * @param {number} targetW
 * @param {number} [maxH=2500]
 * @returns {{buf: Uint8Array, w: number, h: number}}
 */
export function resampleRgb(buf, w, h, targetW, maxH = 2500) {
  const scale = Math.min(targetW / w, maxH / h);
  if (Math.round(w * scale) === w) return { buf, w, h };
  const ow = Math.max(1, Math.round(w * scale));
  const oh = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(ow * oh * 3);

  for (let oy = 0; oy < oh; oy++) {
    // Sample at the centre of each destination pixel.
    const sy = Math.min(h - 1, Math.max(0, ((oy + 0.5) * h) / oh - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;
    for (let ox = 0; ox < ow; ox++) {
      const sx = Math.min(w - 1, Math.max(0, ((ox + 0.5) * w) / ow - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = sx - x0;
      const o00 = (y0 * w + x0) * 3;
      const o01 = (y0 * w + x1) * 3;
      const o10 = (y1 * w + x0) * 3;
      const o11 = (y1 * w + x1) * 3;
      const d = (oy * ow + ox) * 3;
      for (let c = 0; c < 3; c++) {
        const top = buf[o00 + c] + (buf[o01 + c] - buf[o00 + c]) * fx;
        const bot = buf[o10 + c] + (buf[o11 + c] - buf[o10 + c]) * fx;
        out[d + c] = Math.round(top + (bot - top) * fy);
      }
    }
  }
  return { buf: out, w: ow, h: oh };
}

/**
 * Cut a normalized rect out of an RGB24 frame.
 *
 * @param {Uint8Array} buf - RGB24, rows top-down.
 * @param {number} w
 * @param {number} h
 * @param {{x: number, y: number, w: number, h: number}} rect - normalized,
 *   top-left origin; clamped to the frame.
 * @returns {{buf: Uint8Array, w: number, h: number}}
 */
export function cropRgb(buf, w, h, rect) {
  const x0 = Math.max(0, Math.min(w - 1, Math.round(rect.x * w)));
  const y0 = Math.max(0, Math.min(h - 1, Math.round(rect.y * h)));
  const x1 = Math.max(x0 + 1, Math.min(w, Math.round((rect.x + rect.w) * w)));
  const y1 = Math.max(y0 + 1, Math.min(h, Math.round((rect.y + rect.h) * h)));
  const cw = x1 - x0;
  const out = new Uint8Array(cw * (y1 - y0) * 3);
  for (let y = y0; y < y1; y++) {
    out.set(buf.subarray((y * w + x0) * 3, (y * w + x1) * 3), (y - y0) * cw * 3);
  }
  return { buf: out, w: cw, h: y1 - y0 };
}

/**
 * Binarize dark glyphs on a light background to solid black-on-white.
 *
 * Made for the type-badge band: faint grey capitals on the card, further
 * dimmed by the appraisal panel's cream veil, which Windows OCR cannot read
 * as-is but reads perfectly once thresholded. The threshold adapts to the
 * band itself -- a step below its median luminance -- because how much the
 * veil dims the card varies from frame to frame.
 *
 * @param {Uint8Array} buf - RGB24.
 * @returns {Uint8Array} Gray8, every pixel pure black or pure white.
 */
export function inkGlyphs(buf) {
  const hist = new Uint32Array(256);
  const px = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) {
    hist[(0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2]) | 0]++;
  }
  let seen = 0;
  let median = 255;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= px / 2) {
      median = v;
      break;
    }
  }
  const thr = Math.max(140, Math.min(235, median - 28));
  const out = new Uint8Array(px);
  for (let i = 0, d = 0; i < buf.length; i += 3, d++) {
    out[d] = 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2] < thr ? 0 : 255;
  }
  return out;
}

/**
 * Binarize bright glyphs -- the near-white CP text drawn over the scene
 * behind the Pokemon -- to solid black-on-white. A fixed threshold rather
 * than inkGlyphs' adaptive one: the CP line is ~250 on every channel, and
 * requiring every channel that bright cuts out the scene, the yellow buddy
 * star, and the black clock/recording pill in a single test.
 *
 * @param {Uint8Array} buf - RGB24.
 * @returns {Uint8Array} Gray8, every pixel pure black or pure white.
 */
export function brightGlyphs(buf) {
  const out = new Uint8Array(buf.length / 3);
  for (let i = 0, d = 0; i < buf.length; i += 3, d++) {
    out[d] = Math.min(buf[i], buf[i + 1], buf[i + 2]) >= 200 ? 0 : 255;
  }
  return out;
}
