// JavaScript Document
//
// Windows (and WSL) frame probe: the counterpart of the scan.swift path in
// probe.js, producing byte-for-byte the same Frame objects so everything
// downstream is shared. The three jobs scan.swift does are split here:
//
//   decode   ffmpeg, the one install this path needs (`-f rawvideo` frames
//            piped straight in; ffmpeg applies rotation metadata itself)
//   pixels   pixels.js, a pure-JS port of scan.swift's row/strip/box encoder
//   text     ocr.ps1, the OS's built-in Windows.Media.Ocr engine run as a
//            small pool of persistent PowerShell children (no OCR install,
//            like Vision)
//
// Under WSL the same three run with two twists: ffmpeg may be either the
// Linux one or ffmpeg.exe (whichever is installed), and ocr.ps1 is copied
// onto the Windows filesystem first because powershell.exe runs it there.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { platform, env } from 'node:process';
import { analyzePixels } from './pixels.js';
import { brightGlyphs, cropRgb, inkGlyphs, resampleRgb } from './raster.js';
import { countCpBoxes } from './text.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OCR_PS1_PATH = path.join(HERE, 'ocr.ps1');
const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

// The frame is resampled to this width -- up or down -- before OCR. Vision
// reads the appraisal text comfortably even at 384px wide, but Windows OCR
// loses whole digits below ~2x that, and a full-resolution frame is
// needless work. Measured on a 384x832 recording: at 1x the CP came back
// truncated ("0149" for 1498), at ~1000 it was solid on every frame.
// (RecognizeAsync refuses images over 2600px on a side; resampleRgb also
// enforces that, whatever this is set to.)
const OCR_TARGET_WIDTH = 1000;
// The type badges ("WATER / FLYING") sit in a band under the HP text, small
// grey capitals behind the appraisal panel's veil -- too faint for Windows
// OCR in the main pass at any scale. They get a second pass: crop the band,
// binarize it (see inkGlyphs), and blow it up to this width. Vision needs
// none of this, which is why the band size mirrors text.js's TYPE_BAND_DEPTH
// rather than sharing it: readTypes keeps working off whatever boxes arrive.
const BADGE_TARGET_WIDTH = 1200;
const BADGE_BAND_DEPTH = 0.17;
/** Matches text.js's HP_RE loosely: where the band hangs from. */
const HP_LINE_RE = /[0-9]{1,4}\s*[/|]\s*[0-9]{1,4}\s*hp\b/i;
// The CP line is white text over whatever scene sits behind the Pokemon, and
// on a bright scene the main pass loses it entirely -- for some Pokemon on
// every single frame. When the main pass finds no CP, a third pass crops the
// CP band, keeps only near-white pixels (brightGlyphs), and retries. The
// band excludes the clock on the left and the battery/status glyphs on the
// right; the small stylized "CP" glyphs often don't survive the binarize, so
// a bare number here is prefixed back to "CP <n>" before it joins the boxes.
// The left edge matters more than it looks: at 0.1 it clipped the status-bar
// clock's leading digit, and the rest ("3:02" plus an arrow glyph) OCR'd as
// a plausible four-digit CP on every frame of the recording.
const CP_TARGET_WIDTH = 1000;
const CP_TEXT_BAND = { x: 0.2, y: 0.03, w: 0.6, h: 0.08 };
const CP_BAND_TEXT_RE = /^(cp)?[1-9][0-9]{2,4}$/i;
// Windows OCR is the pipeline's slow leg (~350ms a frame against ~100ms of
// JS image prep), so several ocr.ps1 children run OCR on consecutive frames
// concurrently -- each frame still owns one child for all of its passes, and
// frames are yielded strictly in decode order. Sized so the engines don't
// starve each other of cores; POGO_SCAN_WORKERS overrides it.
const OCR_WORKERS =
  Number(env.POGO_SCAN_WORKERS) ||
  Math.max(1, Math.min(4, Math.floor((availableParallelism?.() ?? 4) / 4)));

/** Is this Linux actually Windows underneath? */
export function isWsl() {
  if (platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function commandExists(cmd) {
  try {
    return spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Frame dimensions as ffmpeg will emit them: the stored size, swapped when
 * rotation metadata says the video is displayed on its side (ffmpeg
 * autorotates its output, so the raw frames arrive already upright).
 *
 * @param {object} probeJson - parsed `ffprobe -of json` output.
 * @returns {{w: number, h: number}}
 */
export function pickDimensions(probeJson) {
  const s = probeJson?.streams?.[0];
  if (!s?.width || !s?.height) throw new Error('no video track');
  let rotation = 0;
  for (const d of s.side_data_list ?? []) {
    if (d.rotation !== undefined) rotation = Number(d.rotation) || 0;
  }
  if (!rotation && s.tags?.rotate !== undefined) rotation = Number(s.tags.rotate) || 0;
  const sideways = Math.abs(rotation) % 180 === 90;
  return { w: sideways ? s.height : s.width, h: sideways ? s.width : s.height };
}

/**
 * Turn one ocr.ps1 response into probe.js text boxes: coordinates normalized
 * by the OCR image's own size (so the downscale cancels out), confidence
 * fixed at 1 because Windows OCR reports none -- nothing downstream reads it.
 *
 * @param {{lines?: {s: string, x: number, y: number, w: number, h: number}[], error?: string}} response
 * @param {number} ow - OCR image width in pixels.
 * @param {number} oh
 * @returns {import('./text.js').TextBox[]}
 */
export function parseOcrLines(response, ow, oh) {
  if (response.error) throw new Error(`Windows OCR failed: ${response.error}`);
  return (response.lines ?? []).map((l) => ({
    x: l.x / ow,
    y: l.y / oh,
    w: l.w / ow,
    h: l.h / oh,
    c: 1,
    s: String(l.s ?? ''),
  }));
}

/**
 * Which ffmpeg/ffprobe to run and how to spell the video path for them.
 * Under WSL a native Linux ffmpeg is preferred; a Windows ffmpeg.exe on the
 * PATH works too, fed Windows-style paths via wslpath.
 */
function findFfmpeg(wsl) {
  if (commandExists('ffmpeg') && commandExists('ffprobe')) {
    return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', pathArg: (p) => p };
  }
  if (wsl && commandExists('ffmpeg.exe') && commandExists('ffprobe.exe')) {
    return {
      ffmpeg: 'ffmpeg.exe',
      ffprobe: 'ffprobe.exe',
      pathArg: (p) => spawnSync('wslpath', ['-w', path.resolve(p)], { encoding: 'utf8' }).stdout.trim(),
    };
  }
  throw new Error(
    'videoscan needs ffmpeg on Windows. Install it and reopen the terminal:\n' +
      (wsl ? '  sudo apt install ffmpeg' : '  winget install -e --id Gyan.FFmpeg')
  );
}

/** Where powershell.exe is, from inside WSL or on Windows proper. */
function findPowershell(wsl) {
  if (!wsl) return 'powershell.exe';
  return existsSync(WSL_POWERSHELL) ? WSL_POWERSHELL : 'powershell.exe';
}

/**
 * The ocr.ps1 path as powershell.exe needs it. On Windows that is simply the
 * repo file; under WSL the script is copied to the Windows temp directory
 * (keyed by its own hash, like probe.js's compiled Swift helper) because the
 * repo lives on the Linux filesystem where powershell.exe cannot be trusted
 * to run scripts from.
 */
function ocrScriptArg(wsl, powershell) {
  if (!wsl) return OCR_PS1_PATH;
  const winTmp = spawnSync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', '[IO.Path]::GetTempPath()'],
    { encoding: 'utf8' }
  ).stdout.trim();
  if (!winTmp) throw new Error('could not resolve the Windows temp directory via powershell.exe');
  const hash = createHash('sha256').update(readFileSync(OCR_PS1_PATH)).digest('hex').slice(0, 16);
  const name = `pogo-videoscan-ocr-${hash}.ps1`;
  const wslTmp = spawnSync('wslpath', ['-u', winTmp], { encoding: 'utf8' }).stdout.trim();
  const copy = path.join(wslTmp, name);
  // Not copyFileSync: it preserves permissions, which the /mnt/c drvfs mount
  // rejects with EPERM unless metadata is enabled.
  if (!existsSync(copy)) writeFileSync(copy, readFileSync(OCR_PS1_PATH));
  return winTmp.replace(/[\\/]?$/, '\\') + name;
}

function probeDims({ ffprobe, pathArg }, videoPath) {
  const res = spawnSync(
    ffprobe,
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:stream_tags=rotate:stream_side_data=rotation',
      '-of', 'json',
      pathArg(videoPath),
    ],
    { encoding: 'utf8' }
  );
  if (res.status !== 0) {
    throw new Error(`ffprobe could not read ${videoPath}: ${(res.stderr || '').trim() || 'no output'}`);
  }
  return pickDimensions(JSON.parse(res.stdout));
}

/**
 * Launch ocr.ps1 and wrap it in a strict one-request-one-response line
 * protocol. The returned `send` may only be called again after the previous
 * call resolved, which holding a worker for one frame at a time guarantees.
 */
async function startOcr(powershell, script, signal) {
  const child = spawn(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { stdio: ['pipe', 'pipe', 'pipe'], signal }
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
  });

  const waiters = [];
  const fail = (err) => {
    while (waiters.length) waiters.shift().reject(err);
  };
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.startsWith('{')) return;
    const next = waiters.shift();
    if (!next) return;
    try {
      next.resolve(JSON.parse(line));
    } catch (err) {
      next.reject(err);
    }
  });
  child.on('error', (err) =>
    fail(
      err.code === 'ENOENT'
        ? new Error('videoscan needs powershell.exe for Windows OCR and could not find it')
        : err
    )
  );
  child.on('close', () =>
    fail(new Error(`the Windows OCR helper exited: ${stderr.trim() || 'no output'}`))
  );

  const expect = () => new Promise((resolve, reject) => waiters.push({ resolve, reject }));

  // ocr.ps1 prints {"ready":true} once the OCR engine exists -- or exits
  // with the reason (no English language pack, WinRT unavailable) on stderr,
  // which lands in the rejection above. First run can be slow.
  const readyWait = expect();
  const timer = setTimeout(
    () => fail(new Error('the Windows OCR helper did not start within 120s')),
    120_000
  );
  try {
    await readyWait;
  } finally {
    clearTimeout(timer);
  }

  return {
    send(line) {
      const reply = expect();
      child.stdin.write(`${line}\n`);
      return reply;
    },
    close() {
      try {
        child.stdin.end();
      } catch {}
      if (child.exitCode === null) child.kill();
    },
  };
}

/**
 * A fixed set of ocr.ps1 children handed out one frame at a time. acquire()
 * resolves workers in request order, so frames scheduled in decode order get
 * engines in decode order too.
 */
async function startOcrPool(n, wsl, signal) {
  const powershell = findPowershell(wsl);
  const script = ocrScriptArg(wsl, powershell);
  const workers = await Promise.all(
    Array.from({ length: n }, () => startOcr(powershell, script, signal))
  );
  const idle = [...workers];
  const waiting = [];
  return {
    acquire() {
      if (idle.length) return Promise.resolve(idle.pop());
      return new Promise((resolve) => waiting.push(resolve));
    },
    release(worker) {
      const next = waiting.shift();
      if (next) next(worker);
      else idle.push(worker);
    },
    close() {
      for (const worker of workers) worker.close();
    },
  };
}

/** One round-trip to ocr.ps1 for a Gray8 image. */
async function recognize(ocr, image) {
  const reply = await ocr.send(
    `${image.w} ${image.h} ${Buffer.from(image.buf.buffer, image.buf.byteOffset, image.buf.byteLength).toString('base64')}`
  );
  return parseOcrLines(reply, image.w, image.h);
}

/**
 * Read a frame's text: the main pass over the whole (resampled) frame, then
 * -- when an HP line shows where the card is -- a binarized, enlarged pass
 * over the type-badge band below it, whose boxes are mapped back into
 * whole-frame coordinates and appended. Everything downstream just sees one
 * list of text boxes, like Vision produces in a single pass.
 *
 * @param {{send: (line: string) => Promise<object>}} ocr
 * @param {Uint8Array} frame - full-resolution RGB24.
 * @param {number} w
 * @param {number} h
 * @param {{buf: Uint8Array, w: number, h: number}} ocrImage - the same frame
 *   already at OCR size in Gray8, scaled by ffmpeg alongside the decode
 *   (resampleRgb in JS was the pipeline's biggest main-thread cost).
 * @returns {Promise<import('./text.js').TextBox[]>}
 */
async function ocrFrame(ocr, frame, w, h, ocrImage) {
  const text = await recognize(ocr, ocrImage);

  if (countCpBoxes(text) === 0) {
    const cropped = cropRgb(frame, w, h, CP_TEXT_BAND);
    const scaled = resampleRgb(cropped.buf, cropped.w, cropped.h, CP_TARGET_WIDTH);
    const cpText = await recognize(ocr, { ...scaled, buf: brightGlyphs(scaled.buf) });
    // Every cp-shaped box is kept, not just the first: two cards mid-swipe
    // mean two CPs, and pushing both lets countCpBoxes reject the frame
    // downstream exactly as it does for the main pass.
    for (const box of cpText) {
      const squeezed = String(box.s ?? '').replace(/\s+/g, '');
      if (!CP_BAND_TEXT_RE.test(squeezed)) continue;
      text.push({
        ...box,
        s: /^cp/i.test(squeezed) ? box.s : `CP ${squeezed}`,
        x: CP_TEXT_BAND.x + box.x * CP_TEXT_BAND.w,
        y: CP_TEXT_BAND.y + box.y * CP_TEXT_BAND.h,
        w: box.w * CP_TEXT_BAND.w,
        h: box.h * CP_TEXT_BAND.h,
      });
    }
  }

  const hp = text.find((b) => HP_LINE_RE.test(b.s));
  if (!hp || hp.y >= 1 - 0.02) return text;
  const band = { x: 0, y: hp.y, w: 1, h: Math.min(BADGE_BAND_DEPTH, 1 - hp.y) };
  const cropped = cropRgb(frame, w, h, band);
  const scaled = resampleRgb(cropped.buf, cropped.w, cropped.h, BADGE_TARGET_WIDTH);
  const badgeText = await recognize(ocr, { ...scaled, buf: inkGlyphs(scaled.buf) });
  for (const box of badgeText) {
    text.push({
      ...box,
      x: band.x + box.x * band.w,
      y: band.y + box.y * band.h,
      w: box.w * band.w,
      h: box.h * band.h,
    });
  }
  return text;
}

/**
 * Slice a byte stream into fixed-size frames, buffered a little ahead. The
 * stream is paused while `depth` frames wait, which is what lets ffmpeg's
 * two rawvideo outputs be consumed in lockstep: each pipe drains
 * independently into its queue, so neither can fill up and stall ffmpeg
 * while the loop is waiting on the other.
 *
 * @param {import('node:stream').Readable} stream
 * @param {number} frameSize - bytes per frame.
 * @param {number} depth - frames to hold before pausing the stream.
 * @returns {{next: () => Promise<Buffer | null>}} null at end of stream.
 */
function frameQueue(stream, frameSize, depth) {
  const queue = [];
  // Chunks are collected and only stitched together once a whole frame has
  // arrived: concatenating on every chunk would recopy the accumulation
  // each time, which at OCR-image sizes is most of a scan's CPU.
  let chunks = [];
  let size = 0;
  let ended = false;
  let error;
  let wake = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  stream.on('data', (chunk) => {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= frameSize) {
      const whole = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      let off = 0;
      while (whole.length - off >= frameSize) {
        queue.push(whole.subarray(off, off + frameSize));
        off += frameSize;
      }
      chunks = off < whole.length ? [whole.subarray(off)] : [];
      size = whole.length - off;
    }
    if (queue.length >= depth) stream.pause();
    notify();
  });
  stream.on('end', () => {
    ended = true;
    notify();
  });
  stream.on('error', (err) => {
    error = err;
    ended = true;
    notify();
  });
  return {
    async next() {
      for (;;) {
        if (queue.length) {
          const frame = queue.shift();
          if (queue.length < depth) stream.resume();
          return frame;
        }
        if (error) throw error;
        if (ended) return null;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/**
 * Decode and analyse a video on Windows or WSL, yielding the same Frames as
 * probe.js's Swift path. Options are as probeVideo's, already defaulted.
 *
 * @param {string} videoPath
 * @param {{interval: number, region: object, strip: object, boxes: object[],
 *   signal?: AbortSignal}} opts
 * @returns {AsyncGenerator<import('./probe.js').Frame>}
 */
export async function* probeVideoWin(videoPath, opts) {
  const { interval, region, strip, boxes } = opts;
  const wsl = platform !== 'win32';
  const ff = findFfmpeg(wsl);
  const { w, h } = probeDims(ff, videoPath);

  // OCR-pass dimensions, resampleRgb's formula exactly -- but the scaling
  // itself is done by ffmpeg alongside the decode, which is both SIMD-fast
  // and off this thread. (resampleRgb clamps the same way, so a video that
  // is already OCR-sized comes through both paths untouched.)
  const ocrScale = Math.min(OCR_TARGET_WIDTH / w, 2500 / h);
  const ow = Math.max(1, Math.round(w * ocrScale));
  const oh = Math.max(1, Math.round(h * ocrScale));

  const pool = await startOcrPool(OCR_WORKERS, wsl, opts.signal);
  const child = spawn(
    ff.ffmpeg,
    [
      '-v', 'error',
      '-i', ff.pathArg(videoPath),
      '-filter_complex',
      `[0:v]fps=${1 / interval},split=2[nat][sc];[sc]scale=${ow}:${oh}:flags=bilinear[ocr]`,
      '-map', '[nat]', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
      '-map', '[ocr]', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:3',
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], signal: opts.signal }
  );

  let ffErr = '';
  child.stderr.on('data', (chunk) => {
    ffErr += chunk;
    if (ffErr.length > 64_000) ffErr = ffErr.slice(-64_000);
  });
  const exited = new Promise((resolve, reject) => {
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve(code));
  });

  const native = frameQueue(child.stdout, w * h * 3, OCR_WORKERS + 2);
  const ocrSized = frameQueue(child.stdio[3], ow * oh, OCR_WORKERS + 2);

  let emitted = 0;
  // Frames in flight, oldest first; yielding strictly from the head keeps
  // the output order the decode order no matter which OCR finishes first.
  // Its bound doubles as backpressure: once the window is full nothing reads
  // the pipes until the oldest frame yields, and ffmpeg waits.
  const inFlight = [];
  try {
    for (;;) {
      const frame = await native.next();
      const ocrImage = await ocrSized.next();
      if (!frame || !ocrImage) break;

      const t = Math.round(emitted * interval * 10_000) / 10_000;
      emitted += 1;
      inFlight.push(
        (async () => {
          const worker = await pool.acquire();
          try {
            const text = await ocrFrame(worker, frame, w, h, { buf: ocrImage, w: ow, h: oh });
            const pixels = analyzePixels(frame, w, h, { region, strip, boxes });
            return { t, w, h, text, rows: pixels.rows, strip: pixels.strip, boxes: pixels.boxes };
          } finally {
            pool.release(worker);
          }
        })()
      );
      while (inFlight.length > OCR_WORKERS + 1) yield await inFlight.shift();
    }
    while (inFlight.length) yield await inFlight.shift();
  } finally {
    // On an early exit the tail of the window is abandoned mid-OCR; claim
    // the rejections so they don't surface as unhandled.
    for (const task of inFlight) task.catch(() => {});
    pool.close();
    if (child.exitCode === null) child.kill();
  }

  const code = await exited;
  if (code !== 0 && code !== null) {
    throw new Error(`ffmpeg exited ${code}: ${ffErr.trim() || 'no output'}`);
  }
  if (emitted === 0) {
    throw new Error(`no frames decoded${ffErr.trim() ? `: ${ffErr.trim()}` : ''}`);
  }
}
