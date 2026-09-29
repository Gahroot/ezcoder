// Kinetic Text app shell: loads the compiled recipe and fonts, validates inputs,
// and drives the shared renderer from the HyperFrames timeline.
import { createRenderer } from './pack.js';

const OUT_W = 1920, OUT_H = 1080, MAX_DURATION = 60;
const TEXT_KEYS = ['text1', 'text2', 'text3', 'text4'];
const COLOR_KEYS = ['color1', 'color2', 'color3', 'color4', 'color5'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_TEXT = /^[A-Za-z0-9À-ÖØ-öø-ÿ .,:;!?'"&%$€£@#()\-–—+*/=_|<>«»^~\n]*$/;
const MAX_LINE_CHARS = 40;
const FIT_MARGIN = 8;   // output px kept clear at the frame edge
const DEFAULTS = { variant: '01', text1: '', text2: '', text3: '', text4: '', x: 960, y: 540, scale: 1,
  color1: '', color2: '', color3: '', color4: '', color5: '', weight: 0, background: '#000000' };

async function start() {
  const response = await fetch('assets/recipe.json', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Kinetic Text recipe unavailable');
  const recipe = await response.json();
  if (!recipe || !Array.isArray(recipe.variants) || recipe.variants.length !== 21 || typeof recipe.comps !== 'object') {
    throw new Error('Unexpected Kinetic Text recipe');
  }
  await Promise.all([
    ...[100, 300, 400, 700, 900].map((w) => document.fonts.load(`${w} 100px Inter`)),
  ]);
  const measure = document.createElement('canvas').getContext('2d');
  const renderer = createRenderer(recipe, measure);
  const svgDefs = document.querySelector('#kt-defs');
  const stage = document.querySelector('#kt-stage');
  const place = document.querySelector('#kt-place');
  const bg = document.querySelector('#kt-bg');
  const svg = document.querySelector('#kt-svg');
  const composition = document.querySelector('#composition');
  const clock = { time: 0 };
  const authoredDuration = Number(composition.dataset.duration);
  let state = null;
  let timeline = null;

  const variantOf = (id) => recipe.variants.find((v) => v.id === id);
  const fontVarVariants = new Set(recipe.variants.filter((v) => hasFontVar(recipe, v.comp)).map((v) => v.id));

  function sourceTime(t, s) {
    const extra = authoredDuration - s.variant.duration;
    if (extra <= 0 || t < s.variant.hold) return t;
    if (t < s.variant.hold + extra) return s.variant.hold;
    return t - extra;
  }
  function draw(t, s = state) {
    const frame = renderer.render(sourceTime(t, s));
    svgDefs.innerHTML = frame.defs;
    stage.innerHTML = frame.body;
    const k = s.inputs.scale;
    place.setAttribute('transform', `translate(${s.inputs.x * 2} ${s.inputs.y * 2}) scale(${k}) translate(-1920 -1080)`);
    bg.setAttribute('fill', s.inputs.background);
    svg.setAttribute('aria-label', `Kinetic Text ${s.inputs.variant}: ${visibleTextOf(s)}`);
  }
  function visibleTextOf(s) {
    return s.variant.texts.map((slot, i) => s.inputs[TEXT_KEYS[i]] || slot.default).join(' / ').replace(/[\r\n]+/g, ' ');
  }
  function glyphBounds() {
    const host = composition.getBoundingClientRect();
    const sx = OUT_W / host.width, sy = OUT_H / host.height;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const el of stage.querySelectorAll('.kt-glyph')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      left = Math.min(left, (r.left - host.left) * sx); right = Math.max(right, (r.right - host.left) * sx);
      top = Math.min(top, (r.top - host.top) * sy); bottom = Math.max(bottom, (r.bottom - host.top) * sy);
    }
    return left === Infinity ? null : { left, top, right, bottom };
  }

  function validate(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'Inputs must be an object' };
    for (const key of Object.keys(patch)) if (!(key in DEFAULTS)) return { ok: false, error: `Unknown input "${key}"` };
    const next = { ...(state ? state.inputs : DEFAULTS), ...patch };
    const variant = variantOf(next.variant);
    if (typeof next.variant !== 'string' || !variant) return { ok: false, error: 'variant must be "01" to "21"' };
    if (patch.variant !== undefined && state && patch.variant !== state.inputs.variant) {
      // A new variant starts from its own sample text and colours unless the patch sets them.
      for (const k of [...TEXT_KEYS, ...COLOR_KEYS]) if (!(k in patch)) next[k] = '';
      if (!('weight' in patch)) next.weight = 0;
    }
    if (Math.abs(authoredDuration - variant.duration) > 1e-3 && authoredDuration < variant.duration) {
      return { ok: false, error: `Variant ${variant.id} needs data-duration of at least ${variant.duration} on #composition (found ${authoredDuration})` };
    }
    for (const [i, key] of TEXT_KEYS.entries()) {
      const v = next[key];
      if (typeof v !== 'string') return { ok: false, error: `${key} must be a string` };
      if (v === '') continue;
      const slot = variant.texts[i];
      if (!slot) return { ok: false, error: `Variant ${variant.id} has ${variant.texts.length} text slot(s); ${key} must be empty` };
      if (!v.trim()) return { ok: false, error: `${key} must contain visible characters` };
      if (!ALLOWED_TEXT.test(v)) return { ok: false, error: `${key} has characters the bundled fonts cannot draw (use Latin letters, digits and common punctuation)` };
      const lines = v.split('\n');
      if (lines.length > slot.lines) return { ok: false, error: `${key} allows at most ${slot.lines} line(s) in variant ${variant.id}` };
      // At least 40 characters per line, or the sample's own longest line if that is longer.
      const limit = Math.max(MAX_LINE_CHARS, ...slot.default.split(/\r|\n/).map((l) => Array.from(l).length));
      if (lines.some((l) => Array.from(l).length > limit)) return { ok: false, error: `${key} lines must be ${limit} characters or fewer in variant ${variant.id}` };
    }
    for (const [key, lo, hi] of [['x', 0, OUT_W], ['y', 0, OUT_H], ['scale', 0.25, 2]]) {
      if (typeof next[key] !== 'number' || !Number.isFinite(next[key]) || next[key] < lo || next[key] > hi) {
        return { ok: false, error: `${key} must be a number from ${lo} to ${hi}` };
      }
    }
    const colors = variant.options.filter((o) => o.type === 'color');
    for (const [i, key] of COLOR_KEYS.entries()) {
      const v = next[key];
      if (typeof v !== 'string' || (v !== '' && !HEX.test(v))) return { ok: false, error: `${key} must be "" or a #RRGGBB colour` };
      if (v && i >= colors.length) return { ok: false, error: `Variant ${variant.id} has ${colors.length} colour input(s); ${key} must be empty` };
    }
    if (!Number.isInteger(next.weight) || (next.weight !== 0 && (next.weight < 100 || next.weight > 900))) {
      return { ok: false, error: 'weight must be 0 (source) or an integer from 100 to 900' };
    }
    if (next.weight && !fontVarVariants.has(variant.id)) return { ok: false, error: `Variant ${variant.id} has no adjustable font weight; weight must be 0` };
    if (typeof next.background !== 'string' || !HEX.test(next.background)) return { ok: false, error: 'background must be a #RRGGBB colour' };
    return {
      ok: true, next, variant,
      rendererInputs: { ...next, textLayers: variant.texts.map((s) => s.layer), colorOptions: colors.map((o) => o.effect) },
    };
  }

  function stateFor(valid) {
    return { inputs: valid.next, variant: valid.variant, rendererInputs: valid.rendererInputs };
  }
  // Settled-frame fit: every glyph must stay inside the frame. Variants whose own
  // sample already runs past the frame (tiled/scrolling designs) are checked
  // against their sample's reach instead.
  function fitBounds(s) {
    renderer.setInputs(s.rendererInputs);
    draw(s.variant.hold, s);
    return glyphBounds();
  }
  const designReach = new Map();
  function sampleReach(variant) {
    if (!designReach.has(variant.id)) {
      const sample = validate({ ...DEFAULTS, variant: variant.id });
      designReach.set(variant.id, fitBounds(stateFor(sample)));
    }
    return designReach.get(variant.id);
  }
  // Designed overflow = the variant's own sample already crosses the frame edge (04, 18, 19).
  // Otherwise custom text must keep the sample's clearance from the edge, capped at FIT_MARGIN.
  const clearance = (b) => Math.min(b.left, b.top, OUT_W - b.right, OUT_H - b.bottom);
  function fits(s) {
    const reach = sampleReach(s.variant);
    const b = fitBounds(s);
    if (reach && clearance(reach) >= 0) {
      const need = Math.min(FIT_MARGIN, clearance(reach));
      return !b || clearance(b) >= need ? null : 'The text would run outside the frame at this length, position and scale';
    }
    if (!b || !reach) return null;
    const growth = (b.right - b.left) / Math.max(1, reach.right - reach.left);
    return growth <= 1.5 ? null : 'The text is too long for this variant';
  }

  function setInputs(patch) {
    const valid = validate(patch);
    if (!valid.ok) return valid;
    const candidate = stateFor(valid);
    const previous = state;
    const problem = fits(candidate);
    if (problem) {
      if (previous) { renderer.setInputs(previous.rendererInputs); draw(clock.time, previous); }
      return { ok: false, error: problem };
    }
    state = candidate;
    renderer.setInputs(state.rendererInputs);
    draw(clock.time);
    return { ok: true, state: structuredClone(state.inputs) };
  }

  const declarations = JSON.parse(document.documentElement.dataset.compositionVariables ?? '[]');
  const declared = Object.fromEntries((Array.isArray(declarations) ? declarations : []).map((d) => [d.id, d.default]));
  const first = setInputs({ ...DEFAULTS, ...declared, ...(window.__hyperframes?.getVariables?.() ?? {}) });
  if (!first.ok) throw new Error(first.error);
  if (authoredDuration > MAX_DURATION) throw new Error(`data-duration must be ${MAX_DURATION} seconds or less`);
  timeline = window.gsap.timeline({ paused: true });
  timeline.to(clock, { time: authoredDuration, duration: authoredDuration, ease: 'none', onUpdate: () => draw(clock.time) });
  window.__timelines.main = timeline;
  window.kineticText = {
    setInputs,
    getState: () => structuredClone(state.inputs),
    variants: () => recipe.variants.map((v) => ({ id: v.id, duration: v.duration, hold: v.hold, texts: v.texts.map((s) => ({ sample: s.default.replace(/\r/g, '\n'), lines: s.lines,
      maxLineChars: Math.max(MAX_LINE_CHARS, ...s.default.split(/\r|\n/).map((l) => Array.from(l).length)) })),
      colors: v.options.filter((o) => o.type === 'color').map((o) => ({ name: o.effect })), weight: fontVarVariants.has(v.id) })),
    seek: (t) => { clock.time = Math.max(0, Math.min(authoredDuration, t)); draw(clock.time); return clock.time; },
    glyphBounds,
  };
  window.motionReady = true;
}

function hasFontVar(recipe, compId, depth = 0) {
  const comp = recipe.comps[String(compId)];
  if (!comp || depth > 4) return false;
  return comp.layers.some((l) => l.enabled && (l.fontVar || l.source?.fontVar || (l.kind === 'precomp' && hasFontVar(recipe, l.comp, depth + 1))));
}

await start();
