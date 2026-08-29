// JavaScript Document
//
// Video collection importer: a screen recording of Pokemon GO's appraisal
// screen in, one row per Pokemon out, in the same generic CSV shape
// src/importer already reads.
//
//   probe.js     decode frames, OCR text, run-length encode bar pixels
//                (scan.swift on macOS, probe-win.js on Windows/WSL)
//     -> frame.js   accept/reject each frame, read CP + species + IVs
//     -> group.js   collapse consecutive agreeing frames into one Pokemon
//     -> level.js   derive the level, and cross-check CP/HP against the IVs
//     -> csv.js     write name,atk,def,sta,shadow,level,cp
//
// What is read from where:
//   CP       the "CP 1498" text above the Pokemon (Vision OCR)
//   species  the caught-location caption ("This Trevenant was caught on...")
//            -- never the name above the stats, which is the trainer's own
//            nickname and is usually a rank percentage
//   IVs      the three appraisal bars, measured in pixels (see bars.js)
//   level    solved for, from species + IVs + CP + max HP (see level.js)
//   shadow   the colour of the action button showing above the appraisal
//            panel -- pink PURIFY or green POWER UP (see purify.js)
//
// Recording advice worth passing on to a user: open the appraisal, and rest
// about a second on each Pokemon before swiping. Frames mid-swipe are thrown
// away by design.

import { probeVideo, DEFAULT_REGION } from './probe.js';
import { readFrame } from './frame.js';
import { groupReadings, mergeDuplicates } from './group.js';
import { createCaptionResolver } from './species.js';
import { IV_SNAP_WARN } from './bars.js';

/**
 * @typedef {object} ScannedMon
 * @property {string} speciesId
 * @property {string} name
 * @property {{atk: number, def: number, hp: number}} ivs
 * @property {boolean} shadow
 * @property {boolean} shadowKnown - whether `shadow` was read off the screen
 *   or is the default for a Pokemon nothing on screen described either way.
 * @property {'button'|'aura'|'text'|undefined} shadowSource - what said so.
 * @property {boolean} purified
 * @property {number} cp
 * @property {number} [maxHp]
 * @property {string[]} types - the type badges read off the card, which is
 *   what settles a form the caption left open when the stats cannot.
 * @property {number} [level] - derived; absent when it could not be solved.
 * @property {'exact'|'ambiguous'|'none'|'skipped'} levelStatus
 * @property {number} frames - how many frames this Pokemon was read from.
 * @property {number} tStart
 * @property {number} tEnd
 */

/**
 * Scan a Pokemon GO screen recording into collection rows.
 *
 * @param {string} videoPath
 * @param {object} [opts]
 * @param {number} [opts.interval=0.25] seconds between sampled frames.
 * @param {{x: number, y: number, w: number, h: number}} [opts.region]
 * @param {boolean} [opts.deriveLevels=true] solve each mon's level (boots the
 *   pvpoke engine; set false for a faster, level-less scan).
 * @param {number} [opts.cp=1500] CP cap used only to boot the engine.
 * @param {(progress: {frames: number, accepted: number, t: number}) => void} [opts.onProgress]
 * @returns {Promise<{mons: ScannedMon[], warnings: string[], stats: {frames: number, accepted: number, rejected: Record<string, number>}}>}
 */
export async function scanVideo(videoPath, opts = {}) {
  return scanFrames(
    probeVideo(videoPath, {
      interval: opts.interval,
      region: opts.region ?? DEFAULT_REGION,
      signal: opts.signal,
    }),
    { ...opts, source: videoPath }
  );
}

/**
 * The whole pipeline downstream of decoding, over any iterable of frames.
 * `scanVideo` is this fed by the platform probe; tests feed it recorded frames.
 *
 * @param {AsyncIterable<import('./probe.js').Frame>|Iterable<import('./probe.js').Frame>} source
 * @param {object} [opts] - as scanVideo, minus the decoding options.
 * @returns {Promise<{mons: ScannedMon[], warnings: string[], stats: object}>}
 */
export async function scanFrames(source, opts = {}) {
  const resolveCaption = createCaptionResolver();
  const warnings = [];
  const rejected = {};
  const frames = [];
  let accepted = 0;

  for await (const frame of source) {
    const result = readFrame(frame, { resolveCaption });
    if (result.reading) {
      accepted += 1;
    } else {
      const key = result.detail ? `${result.reason}: "${result.detail}"` : result.reason;
      rejected[key] = (rejected[key] ?? 0) + 1;
    }
    frames.push({ t: frame.t, reading: result.reading, hint: result.hint });
    opts.onProgress?.({ frames: frames.length, accepted, t: frame.t });
  }

  if (frames.length === 0) throw new Error(`No frames decoded from ${opts.source ?? 'input'}`);

  const { mons: groups, merged } = mergeDuplicates(groupReadings(frames, opts));
  for (const name of merged) {
    warnings.push(
      `${name}: appeared more than once in the recording with identical CP and IVs -- ` +
        'written as one row (if you really own two, add the second by hand)'
    );
  }

  // Shadow is read twice over: from the PURIFY / POWER UP band above the
  // appraisal panel (purify.js), which states it outright, and where that
  // band is hidden -- which happens on any card whose page is scrolled past
  // it -- from the purple smoke around the Pokemon itself (aura.js), which
  // only resembles it. Which of the two answered matters to the trainer,
  // because a shadow Pokemon written as an ordinary one looks completely
  // normal in the CSV. Saying nothing would leave them to assume every row
  // was checked the same way.
  const unchecked = groups.filter((g) => !g.shadowKnown);
  const shadows = groups.filter((g) => g.shadow);
  const byAura = groups.filter((g) => g.shadowSource === 'aura');
  const auraShadows = byAura.filter((g) => g.shadow);
  warnings.push(
    `Shadow read from the screen for ${groups.length - unchecked.length} of ${groups.length} Pokemon` +
      `${shadows.length ? `; ${shadows.length} of them are shadow (${shadows.map((g) => g.name).join(', ')})` : ', none of them shadow'}.`
  );
  if (byAura.length > 0) {
    warnings.push(
      `${byAura.length} of those had the PURIFY button hidden behind the appraisal panel and were judged by ` +
        `the purple aura around the Pokemon instead${auraShadows.length ? `, which found ${auraShadows.length} shadow (${auraShadows.map((g) => g.name).join(', ')})` : ', and found none shadow'}. ` +
        'The aura is a resemblance rather than a statement -- it got all 26 shadows and none of the 231 ' +
        'ordinary Pokemon in the recordings it was measured against, but it is the half of this scan worth ' +
        'a second look.'
    );
  }
  if (unchecked.length > 0) {
    warnings.push(
      `Shadow could NOT be read at all for ${unchecked.length} of ${groups.length} Pokemon ` +
        `(${unchecked.map((g) => g.name).join(', ')}) -- the button was hidden and no frame of ` +
        `${unchecked.length === 1 ? 'it' : 'them'} could be measured for an aura. ` +
        'Those rows are written as not shadow whether they are or not.'
    );
  }

  for (const key of Object.keys(rejected)) {
    if (key.startsWith('unrecognized species')) {
      warnings.push(`Could not match a species name read from the video -- ${key.slice('unrecognized species: '.length)}`);
    }
  }

  const mons = groups.map((group) => ({
    speciesId: group.speciesId,
    name: group.name,
    ivs: group.ivs,
    shadow: group.shadow,
    // false when nothing on any frame of this Pokemon stated shadow either
    // way, so `shadow: false` above is a default rather than a reading.
    shadowKnown: group.shadowKnown,
    shadowSource: group.shadowSource,
    purified: group.purified,
    cp: group.cpVotes[0]?.value,
    maxHp: group.maxHp,
    types: group.types ?? [],
    levelStatus: 'skipped',
    frames: group.frames,
    tStart: group.tStart,
    tEnd: group.tEnd,
  }));

  for (const [i, group] of groups.entries()) {
    const mon = mons[i];
    if (group.frames === 1) {
      warnings.push(
        `${mon.name}: read from a single frame -- rest a little longer on each ` +
          'Pokemon, or rescan with a smaller --interval, if this row looks wrong'
      );
    }
    if (group.maxDelta > IV_SNAP_WARN) {
      warnings.push(
        `${mon.name}: an appraisal bar measured ${group.maxDelta.toFixed(2)} of an IV ` +
          'away from a whole number -- the reading may be off by one'
      );
    }
  }

  if (opts.deriveLevels !== false) {
    await resolveStats(mons, groups, warnings, opts.cp ?? 1500);
    // resolveStats marks the rows its arithmetic proved to be misreads.
    for (let i = mons.length - 1; i >= 0; i--) {
      if (mons[i].dropped) mons.splice(i, 1);
    }
  } else {
    // Which form a caption meant is settled by the CP/HP arithmetic, so
    // --no-level leaves it at the likeliest guess rather than an answer.
    for (const group of groups) {
      if ((group.candidates?.length ?? 0) > 1) {
        warnings.push(
          `${group.name}: the caption never says which form and --no-level skipped the ` +
            'arithmetic that would settle it -- wrote the likeliest, rescan without --no-level to be sure'
        );
      }
    }
  }

  return { mons, warnings, stats: { frames: frames.length, accepted, rejected } };
}

/**
 * Settle each scanned Pokemon's form, CP and level against pvpoke's own CP math.
 *
 * CP, max HP and the three IVs over-determine each other, and that redundancy
 * is the only defence this scanner has against its three unavoidable misreads:
 * the Pokemon's animation is drawn over the CP text, the appraisal bars animate
 * in, and the caught-location caption never names a form ("This Corsola was
 * caught on ..." for a Galarian one). So rather than trusting the CP that was
 * read, we ask which CP this Pokemon *could* have -- given its species, its
 * IVs, and the max HP printed inside the card where nothing covers it -- and
 * check the readings against that, once per form the caption could have meant.
 */
async function resolveStats(mons, groups, warnings, cp) {
  const { initEngine } = await import('../engine/harness.js');
  const { createLevelDeriver } = await import('./level.js');
  const ctx = await initEngine({ cp });
  const deriveLevel = createLevelDeriver(ctx);

  for (const [i, mon] of mons.entries()) {
    const group = groups[i];
    const votes = group.cpVotes;
    const candidates = group.candidates?.length
      ? group.candidates
      : [{ speciesId: mon.speciesId, name: mon.name, types: [] }];

    const tried = candidates.map((candidate, rank) =>
      settleAs(candidate, rank, mon, votes, group.types ?? [], group.badges ?? [], deriveLevel)
    );
    let best = tried.reduce((a, b) => (compareFits(a, b) <= 0 ? a : b));

    if (candidates.length > 1) {
      mon.speciesId = best.candidate.speciesId;
      mon.name = best.candidate.name;
      const note = formWarning(best, tried, group.types ?? []);
      if (note) warnings.push(note);
    }

    // Second look at the bars, now that the form is settled: when no CP that
    // was literally read fits the bars as measured, but shifting exactly one
    // stat by one notch makes a read CP, the HP and the level agree
    // perfectly, the bar was measured a hair on the wrong side of a notch --
    // the appraisal bar is the one reading here with an analog failure mode,
    // and CP text does not misread into a number that fits this well.
    const fixed = ivVariantFix(best, votes, deriveLevel);
    if (fixed) {
      warnings.push(
        `${mon.name}: CP ${fixed.cp} was read off the screen but no level produces it with the bars ` +
          `as measured (${mon.ivs.atk}/${mon.ivs.def}/${mon.ivs.hp}) -- ` +
          `${fixed.ivs.atk}/${fixed.ivs.def}/${fixed.ivs.hp} fits it and the ${mon.maxHp} HP exactly, ` +
          'so one bar was taken to be off by a notch'
      );
      mon.ivs = fixed.ivs;
      best = {
        ...best,
        cp: fixed.cp,
        chosen: { cp: fixed.cp, evidence: 'exact', reconstructed: false },
        possible: fixed.possible,
        fit: fixed.fit,
        hpIgnored: false,
      };
    }

    // Everything below is reported for the form that was chosen, in the same
    // words it would have used had there only ever been one.
    if (mon.maxHp !== undefined) {
      if (best.chosen) {
        if (best.chosen.reconstructed) {
          warnings.push(
            `${mon.name}: the CP text read as ${votes.map((v) => v.value).join('/')} -- the Pokemon's ` +
              `animation covers it. ${best.chosen.cp} is the only CP that fits ${mon.maxHp} HP with ` +
              `${mon.ivs.atk}/${mon.ivs.def}/${mon.ivs.hp}, so that is what was written`
          );
        }
      } else if (best.possible.status === 'none') {
        warnings.push(
          `${mon.name}: no level gives ${mon.maxHp} HP with IVs ` +
            `${mon.ivs.atk}/${mon.ivs.def}/${mon.ivs.hp} -- this row is probably misread, check it`
        );
      } else {
        warnings.push(
          `${mon.name} (CP ${best.cp}): could not settle the CP -- ${mon.maxHp} HP allows ` +
            `${[...new Set(best.possible.cps)].join(', ')} and the screen read ` +
            `${votes.map((v) => v.value).join('/')}`
        );
      }
    }
    mon.cp = best.cp;

    if (mon.cp === undefined) {
      warnings.push(`${mon.name}: no CP could be read or derived -- row written without one`);
      mon.levelStatus = 'none';
      continue;
    }

    if (best.hpIgnored) {
      warnings.push(
        `${mon.name} (CP ${mon.cp}): CP and IVs agree but the "${mon.maxHp} HP" reading does not -- ` +
          'level taken from CP alone'
      );
    }
    mon.level = best.fit.level;
    mon.levelStatus = best.fit.status;

    if (best.fit.status === 'none') {
      if (group.frames === 1 && (mon.maxHp === undefined || best.possible.status === 'none')) {
        // One frame, nothing to corroborate it, and a CP the stats rule out:
        // that is a swipe-blur misread, not a Pokemon. It shows up when the
        // OCR garbles one digit of the CP on a single frame, which splits the
        // real Pokemon's run in two and leaves the bad frame as a group of
        // its own -- the real Pokemon is still written from its other frames.
        // An HP is corroboration only if it is consistent with something: a
        // lone frame whose HP fits its IVs at no level either is the same
        // swipe blur with one more garbled number in it.
        mon.dropped = true;
        warnings.push(
          `${mon.name}: one frame read CP ${mon.cp}, which no level produces with IVs ` +
            `${mon.ivs.atk}/${mon.ivs.def}/${mon.ivs.hp} -- dropped as a misread`
        );
      } else {
        warnings.push(
          `${mon.name} (CP ${mon.cp}): no level produces CP ${mon.cp} with IVs ` +
            `${mon.ivs.atk}/${mon.ivs.def}/${mon.ivs.hp} -- this row is probably misread, check it before using it`
        );
      }
    } else if (best.fit.status === 'ambiguous') {
      warnings.push(
        `${mon.name} (CP ${mon.cp}): levels ${best.fit.candidates.join(', ')} all fit -- wrote ${best.fit.level}`
      );
    }
  }
}

/**
 * Read one Pokemon as if it were a particular form, and report how well that
 * reading holds together. Emits nothing: resolveStats warns only about the
 * form it ends up keeping.
 *
 * @param {{speciesId: string, name: string, types: string[]}} candidate
 * @param {number} rank - the caption's own preference order (see forms.js).
 * @param {{ivs: object, shadow: boolean, maxHp?: number}} mon
 * @param {{value: number, count: number}[]} votes - CPs read off the screen.
 * @param {string[]} types - type badges read off the screen.
 * @param {string[][][]} badges - per frame, per badge circle, the types its
 *   colour could be (see badges.js).
 * @param {ReturnType<import('./level.js').createLevelDeriver>} deriveLevel
 */
function settleAs(candidate, rank, mon, votes, types, badges, deriveLevel) {
  const key = { speciesId: candidate.speciesId, shadow: mon.shadow, ivs: mon.ivs };
  let possible = { status: 'none', cps: [], candidates: [] };
  let chosen = null;
  if (mon.maxHp !== undefined) {
    possible = deriveLevel({ ...key, maxHp: mon.maxHp });
    chosen = chooseCp(votes, possible.cps);
  }
  let cp = chosen?.cp;
  if (cp === undefined && votes.length > 0) {
    // No HP to arbitrate between the readings (or none of them fits it).
    // Commonest-first is the wrong order when a recurring artifact outvotes
    // the real number, so prefer the first reading the stats can explain at
    // all -- a CP that exists at some level over one that exists at none.
    const backed = votes.find((v) => deriveLevel({ ...key, cp: v.value }).status !== 'none');
    cp = (backed ?? votes[0]).value;
  }

  let fit = { status: 'none', candidates: [], cps: [] };
  let hpIgnored = false;
  if (cp !== undefined) {
    fit = deriveLevel({ ...key, cp, maxHp: mon.maxHp });
    if (fit.status === 'none' && mon.maxHp !== undefined) {
      // Separate "the HP text was misread" from "the IVs are wrong": only the
      // second is alarming. A form that needs this concession is also a worse
      // explanation than one that does not (see compareFits).
      const cpOnly = deriveLevel({ ...key, cp });
      if (cpOnly.status !== 'none') {
        fit = cpOnly;
        hpIgnored = true;
      }
    }
  }

  return {
    candidate,
    rank,
    mon,
    cp,
    chosen,
    possible,
    fit,
    hpIgnored,
    // A badge Vision actually read names this card's own type, so a form that
    // cannot have it is ruled out -- the only thing that separates Oricorio's
    // four forms, which are stat-for-stat identical.
    typeOk: types.length === 0 || candidate.types.length === 0 || types.every((t) => candidate.types.includes(t)),
    badgeOut: badgeOut(candidate, badges),
  };
}

/**
 * On how many frames do the badge circles' colours rule this form out?
 *
 * A frame rules a form out when it shows more circles than the form has
 * types, or a circle whose colour could be none of them -- a plain Weezing
 * has one badge where a Galarian one has two, and a pink second circle is
 * not poison however it is read. Circles whose colour matched nothing on the
 * palette (the avatar's hair clipping the row) say nothing and are skipped.
 *
 * @param {{types: string[]}} candidate
 * @param {string[][][]} badges - per frame, per circle, its plausible types.
 * @returns {number}
 */
function badgeOut(candidate, badges) {
  const t = candidate.types;
  if (t.length === 0) return 0;
  let out = 0;
  for (const frame of badges) {
    const named = frame.filter((set) => set.length > 0);
    if (named.length === 0) continue;
    if (named.length > t.length || named.some((set) => !set.some((type) => t.includes(type)))) out += 1;
  }
  return out;
}

/**
 * The one-notch bar correction resolveStats applies after the form is
 * settled: the single ±1-of-one-stat variant of the measured IVs, if exactly
 * one exists, under which a CP that was literally read off the screen agrees
 * with the max HP at an exact level. Null when the reading needs no fixing
 * (a read CP already fits) or no unique variant explains it.
 *
 * @returns {{ivs: object, cp: number, fit: object, possible: object}|null}
 */
function ivVariantFix(best, votes, deriveLevel) {
  const { mon, candidate } = best;
  if (mon.maxHp === undefined || votes.length === 0) return null;
  if (best.chosen?.evidence === 'exact') return null;

  const hits = [];
  for (const stat of ['atk', 'def', 'hp']) {
    for (const d of [-1, 1]) {
      const ivs = { ...mon.ivs, [stat]: mon.ivs[stat] + d };
      if (ivs[stat] < 0 || ivs[stat] > 15) continue;
      const key = { speciesId: candidate.speciesId, shadow: mon.shadow, ivs };
      const possible = deriveLevel({ ...key, maxHp: mon.maxHp });
      const agreed = votes.find((v) => possible.cps.includes(v.value));
      if (!agreed) continue;
      const fit = deriveLevel({ ...key, cp: agreed.value, maxHp: mon.maxHp });
      if (fit.status !== 'exact') continue;
      hits.push({ ivs, cp: agreed.value, fit, possible });
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * How well one reading explains the screen, best first. The stats come before
 * the type badge deliberately: the badge is a single OCR box that Vision
 * truncates half the time, while CP, max HP and three IVs have to agree
 * simultaneously and almost never do so for the wrong form.
 */
function scoreFit(r) {
  return [
    r.fit.status === 'none' ? 0 : 1, // a form that produces no level at all is out
    r.hpIgnored ? 0 : 1, // ... then one that explains the CP *and* the HP
    // ... and the CP by the strength of its evidence: literally read beats
    // recovered from a truncation ("172" narrows 1272 vs 1271), which beats
    // merely being the only number the stats allow.
    { exact: 2, partial: 1 }[r.chosen?.evidence] ?? 0,
    r.fit.status === 'exact' ? 1 : 0,
    r.typeOk ? 1 : 0, // ... and only then the badges, to break what is left:
    -r.badgeOut, // the text first, then the circles' colours (fewest frames ruling it out)
  ];
}

/**
 * Do two readings explain the screen equally well? `upTo` limits the
 * comparison to the leading criteria -- 4 is "the numbers alone cannot tell
 * these two apart", which is the question the type badge exists to answer.
 */
function tiedFit(a, b, upTo = Infinity) {
  const [x, y] = [scoreFit(a), scoreFit(b)];
  return x.every((v, i) => i >= upTo || v === y[i]);
}

/**
 * Which of two readings of the same Pokemon is the better explanation.
 * Negative means `a` wins; a genuine tie falls back to the caption's own
 * preference order (an ordinary Rattata over an Alolan one -- see forms.js).
 */
function compareFits(a, b) {
  const [x, y] = [scoreFit(a), scoreFit(b)];
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return a.rank - b.rank;
}

/**
 * Why one form was written rather than the others the caption allowed --
 * raised only when the answer was not simply "the numbers said so": either a
 * form other than the obvious one won, or nothing on screen could separate
 * them and a default had to be taken (see DEFAULT_FORMS).
 *
 * @returns {string|null} null when the choice needs no explaining.
 */
function formWarning(best, tried, types) {
  const rest = tried.filter((t) => t !== best);
  const tied = rest.filter((t) => tiedFit(t, best));
  const tiedOnNumbers = rest.filter((t) => tiedFit(t, best, 4));
  const lead = `${best.candidate.name}: the caught-location caption never says which form`;

  if (tied.length > 0) {
    return (
      `${lead}, and nothing on screen separates it from ${tied.map((t) => t.candidate.name).join(', ')} -- ` +
      'wrote the form Pokemon GO stores by default; correct the row by hand if it is one of the others'
    );
  }
  if (tiedOnNumbers.length > 0) {
    const evidence = types.length
      ? `the "${types.join('/')}" badge on the card`
      : "the colour of the card's type badges";
    return (
      `${lead} and its stats fit ${tiedOnNumbers.length + 1} of them equally -- ${evidence} ` +
      `is ${best.candidate.name} and not ${tiedOnNumbers.map((t) => t.candidate.name).join(', ')}`
    );
  }
  if (best.rank === 0) return null; // the likeliest form, and the numbers agree
  return (
    `${lead} -- of ${tried.length}, only this one has a level that gives CP ${best.cp}` +
    (best.mon.maxHp === undefined ? '' : ` and ${best.mon.maxHp} HP`) +
    ` with ${best.mon.ivs.atk}/${best.mon.ivs.def}/${best.mon.ivs.hp} ` +
    `(not ${rest.map((t) => t.candidate.name).join(', ')})`
  );
}

/**
 * Pick this Pokemon's CP from what the screen said and what its stats allow.
 *
 * @param {{value: number, count: number}[]} votes - CPs read, commonest first.
 * @param {number[]} possible - CPs its species/IVs/HP permit.
 * @returns {{cp: number, reconstructed: boolean}|null}
 */
export function chooseCp(votes, possible) {
  const allowed = [...new Set(possible)];
  if (allowed.length === 0) return null;

  // Best case: a CP that was actually read is one the stats allow.
  const agreed = votes.find((v) => allowed.includes(v.value));
  if (agreed) return { cp: agreed.value, evidence: 'exact', reconstructed: false };

  // Otherwise the number on screen was cut off. A truncated reading is still
  // evidence: "96" narrows 968 vs 1968 the way no other signal can.
  const partial = allowed.filter((cp) => votes.some((v) => partialRead(String(cp), String(v.value))));
  if (partial.length === 1) return { cp: partial[0], evidence: 'partial', reconstructed: true };
  if (allowed.length === 1) return { cp: allowed[0], evidence: 'sole', reconstructed: true };
  return null;
}

/**
 * Could `read` be `whole` with one contiguous span of digits covered? The
 * animation crosses the CP text as one shape, so it takes out the start, the
 * end, or a run in the middle -- "172" is 1272 with the 2 covered, and a
 * mid-gap needs at least a digit surviving on each side before it counts.
 */
function partialRead(whole, read) {
  if (read.length >= whole.length) return false;
  if (whole.startsWith(read) || whole.endsWith(read)) return true;
  for (let take = 1; take < read.length; take++) {
    if (whole.startsWith(read.slice(0, take)) && whole.endsWith(read.slice(take))) return true;
  }
  return false;
}
