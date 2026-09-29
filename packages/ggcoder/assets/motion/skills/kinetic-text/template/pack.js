// Kinetic Text: one shared renderer for all 21 variants.
// It plays compiled recipe data (keyframes, text animators, shapes, mattes and a
// small set of named rig mechanisms). It never evaluates After Effects code.
const COMP_W = 3840, COMP_H = 2160, OUT_W = 1920, OUT_H = 1080, FPS = 30;
const MAX_DURATION = 60;
const TEXT_KEYS = ['text1', 'text2', 'text3', 'text4'];
const COLOR_KEYS = ['color1', 'color2', 'color3', 'color4', 'color5'];
const HEX = /^#[0-9a-fA-F]{6}$/;
// Latin letters, digits, common punctuation and Latin-1 accents: all covered by the shipped fonts.
const ALLOWED_TEXT = /^[A-Za-z0-9À-ÖØ-öø-ÿ .,:;!?'"&%$€£@#()\-–—+*/=_|<>«»^~\n]*$/;
const FAMILY_STACK = { Inter: 'Inter, sans-serif' };   // the only bundled face
const SYMBOLS = ['|', '_', '\u2014', '<', '>', '\u00ab', '\u00bb', '^'];

// ------------------------------------------------------------------ math
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, u) => a + (b - a) * u;
const isArr = Array.isArray;
function mul(a, b) {   // 2D affine [a b c d e f]
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
const I2 = [1, 0, 0, 1, 0, 0];
const tr = (x, y) => [1, 0, 0, 1, x, y];
const sc = (x, y) => [x, 0, 0, y, 0, 0];
function rot(deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, 0, 0]; }
function skewM(deg, axisDeg) {
  if (!deg) return I2;
  const k = Math.tan(-deg * Math.PI / 180);
  return mul(rot(axisDeg), mul([1, 0, k, 1, 0, 0], rot(-axisDeg)));
}
const fmt = (m) => `matrix(${m.map((v) => +v.toFixed(4)).join(' ')})`;
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function hash(a, b, c) {   // deterministic 0..1
  let h = 2166136261 ^ Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function bezier1(x1, y1, x2, y2, x) {   // cubic-bezier(x1,y1,x2,y2) evaluated at x
  let lo = 0, hi = 1, u = x;
  for (let i = 0; i < 30; i++) {
    const bx = 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
    if (bx < x) lo = u; else hi = u;
    u = (lo + hi) / 2;
  }
  return 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
}
const escapeXml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function hexOf(c) {
  if (!isArr(c)) return 'none';
  return '#' + c.slice(0, 3).map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');
}
function rgbOfHex(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(1); }

// ------------------------------------------------------------------ easing
const PENNER = {
  Quad: [(u) => u * u], Cubic: [(u) => u ** 3], Quart: [(u) => u ** 4], Quint: [(u) => u ** 5],
  Sine: [(u) => 1 - Math.cos(u * Math.PI / 2)], Circ: [(u) => 1 - Math.sqrt(1 - u * u)],
  Expo: [(u) => (u === 0 ? 0 : 2 ** (10 * (u - 1)))], Back: [(u) => u * u * (2.70158 * u - 1.70158)],
};
function ewEase(name, u) {   // Ease and Wizz families, normalised to 0..1
  const m = /^(inOut|in|out)(\w+)$/.exec(name);
  const f = m && PENNER[m[2]];
  if (!f) return u;
  const e = f[0];
  if (m[1] === 'in') return e(u);
  if (m[1] === 'out') return 1 - e(1 - u);
  return u < 0.5 ? e(2 * u) / 2 : 1 - e(2 - 2 * u) / 2;
}
function keyed(keys, t, ew) {
  const n = keys.length;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[n - 1].t) return keys[n - 1].v;
  let i = 0;
  while (i < n - 2 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1], dt = b.t - a.t;
  if (a.o === 'H' || dt <= 0) return a.v;
  const u = (t - a.t) / dt;
  if (ew) {
    const w = ewEase(ew, u);
    return isArr(a.v) ? a.v.map((v, d) => lerp(v, b.v[d], w)) : lerp(a.v, b.v, w);
  }
  if (a.o === 'L' && b.i === 'L') return isArr(a.v) ? a.v.map((v, d) => lerp(v, b.v[d], u)) : lerp(a.v, b.v, u);
  const curve = (v0, v1, eo, ei) => {
    const slope = (v1 - v0) / dt;
    const [s1, i1] = a.o === 'L' ? [slope, 100 / 3] : (eo || [slope, 100 / 3]);
    const [s2, i2] = b.i === 'L' ? [slope, 100 / 3] : (ei || [slope, 100 / 3]);
    const x1 = Math.min(i1, 100) / 100, x2 = 1 - Math.min(i2, 100) / 100;
    if (v1 === v0 && !s1 && !s2) return v0;
    const range = v1 - v0 || 1;
    const y1 = (s1 * x1 * dt) / range, y2 = 1 - (s2 * (1 - x2) * dt) / range;
    return v0 + (v1 - v0 === 0 ? 0 : range * bezier1(x1, y1, x2, y2, u));
  };
  if (!isArr(a.v)) return curve(a.v, b.v, a.eo[0], b.ei[0]);
  if (a.sp && a.v.length >= 2) {   // spatial: ease the distance travelled along the straight path
    const len = Math.hypot(...a.v.map((v, d) => b.v[d] - v));
    if (len === 0) return a.v;
    const s = curve(0, len, a.eo[0], b.ei[0]) / len;
    return a.v.map((v, d) => lerp(v, b.v[d], s));
  }
  return a.v.map((v, d) => curve(v, b.v[d], a.eo[d] || a.eo[0], b.ei[d] || b.ei[0]));
}

// ------------------------------------------------------------------ renderer
export function createRenderer(recipe, measureCtx) {
  const comps = recipe.comps;
  const layoutCache = new Map();
  let inputs = null;   // validated inputs of the active state
  let frameCache = new Map();
  let defs = [];
  let uid = 0;

  // A layer "instance" = a recipe layer inside a comp instance (precomps nest).
  function compInstance(compId, parent, offset) {
    const comp = comps[String(compId)];
    const ci = { comp, parent, offset, byId: new Map(), byName: new Map(), root: parent ? parent.root : null };
    if (!parent) ci.root = ci;
    for (const rec of comp.layers) {
      const L = { rec, ci };
      ci.byId.set(rec.id, L);
      if (!ci.byName.has(rec.name)) ci.byName.set(rec.name, L);
    }
    return ci;
  }
  function findLayer(ci, name) {
    for (let c = ci; c; c = c.parent) { const L = c.byName.get(name); if (L) return L; }
    return null;
  }

  // ---------------------------------------------------------- values
  function val(p, L, t) {
    if (!p) return undefined;
    let base = p.v;
    if (p.k && p.k.length) base = keyed(p.k, t, p.ew);
    return p.x ? mech(p.x, base, L, t) : base;
  }
  function control(L, effect, param) {
    const params = L && L.rec.ctl[effect];
    return params ? params[param] : undefined;
  }
  function fxv(L, layerName, effect, param, t) {
    const target = layerName ? findLayer(L.ci, layerName) : L;
    if (!target) return 0;
    const override = optionOverride(target, effect);
    if (override) return override;
    const p = control(target, effect, param);
    const v = p === undefined ? 0 : val(p, target, t);
    return v === undefined || v === null ? 0 : v;
  }
  function optionOverride(target, effect) {
    if (!inputs || target.rec.name !== 'Options' || target.ci !== target.ci.root) return null;
    const idx = inputs.colorOptions.indexOf(effect);
    return idx >= 0 && inputs[COLOR_KEYS[idx]] ? rgbOfHex(inputs[COLOR_KEYS[idx]]) : null;
  }
  const arith = (op, a, b) => {
    if (isArr(a) || isArr(b)) {
      const n = Math.max(isArr(a) ? a.length : 0, isArr(b) ? b.length : 0);
      return Array.from({ length: n }, (_, i) => arith(op, isArr(a) ? a[i] ?? 0 : a, isArr(b) ? b[i] ?? 0 : b));
    }
    if (op === '+') return a + b;
    if (op === '-') return a - b;
    if (op === '*') return a * b;
    return b === 0 ? 0 : a / b;
  };
  function tree(n, L, t, value) {
    if ('n' in n) return n.n;
    if (n.id) {
      switch (n.id) {
        case 'time': return t;
        case 'inPoint': return L.rec.in;
        case 'outPoint': return L.rec.out;
        case 'value': return value;
        case 'compWidth': return L.ci.comp.w;
        case 'compHeight': return L.ci.comp.h;
        case 'frameDuration': return 1 / FPS;
        default: return 0;
      }
    }
    if (n.neg) return arith('*', tree(n.neg, L, t, value), -1);
    if (n.op) return arith(n.op, tree(n.a, L, t, value), tree(n.b, L, t, value));
    if (n.arr) return n.arr.map((x) => tree(x, L, t, value));
    if (n.idx) { const v = tree(n.idx[0], L, t, value); return isArr(v) ? v[n.idx[1]] ?? 0 : v; }
    if (n.fx) return fxv(L, n.fx.layer, n.fx.effect, n.fx.param, t);
    if (n.tr) {
      const target = n.tr.layer ? findLayer(L.ci, n.tr.layer) : L;
      return target ? transformValue(target, n.tr.prop, t) : 0;
    }
    if (n.sel) {
      const a = (L.rec.animators || []).find((x) => x.name === n.sel.animator);
      const s = a && a.sel[0];
      return s ? val(s[n.sel.prop], L, t) ?? 0 : 0;
    }
    if (n.aprop) return animatorProp(L, n.aprop.animator, n.aprop.prop, t);
    if (n.fn) {
      const a = n.args.map((x) => tree(x, L, t, value));
      switch (n.fn) {
        case 'linear': case 'ease': case 'easeIn': case 'easeOut': {
          const [x, x0, x1, y0, y1] = a.length === 3 ? [a[0], 0, 1, a[1], a[2]] : a;
          let u = x1 === x0 ? (x >= x1 ? 1 : 0) : clamp01((x - x0) / (x1 - x0));
          if (n.fn === 'ease') u = u * u * (3 - 2 * u);
          if (n.fn === 'easeIn') u = u * u;
          if (n.fn === 'easeOut') u = 1 - (1 - u) * (1 - u);
          return isArr(y0) ? y0.map((v, i) => lerp(v, y1[i], u)) : lerp(y0, y1, u);
        }
        case 'clamp': return Math.min(a[2], Math.max(a[1], a[0]));
        case 'Math.floor': return Math.floor(a[0]);
        case 'Math.round': return Math.round(a[0]);
        case 'Math.max': return Math.max(...a);
        case 'Math.min': return Math.min(...a);
        case 'Math.abs': return Math.abs(a[0]);
        case 'timeToFrames': return Math.round(a[0] * FPS);
        default: return 0;
      }
    }
    return 0;
  }
  const PROP_ALIAS = { trackingAmount: 'tracking', anchorPoint: 'anchor' };
  function animatorProp(L, name, prop, t) {
    const a = (L.rec.animators || []).find((x) => x.name === name);
    const p = a && a.props[PROP_ALIAS[prop] || prop];
    return p ? val(p, L, t) ?? 0 : 0;
  }
  function transformValue(L, prop, t) {
    const tf = L.rec.tf;
    if (prop === 'position') return tf.pos ? val(tf.pos, L, t) : [val(tf.px, L, t), val(tf.py, L, t), 0];
    if (prop === 'xPosition') return tf.px ? val(tf.px, L, t) : val(tf.pos, L, t)[0];
    if (prop === 'yPosition') return tf.py ? val(tf.py, L, t) : val(tf.pos, L, t)[1];
    if (prop === 'anchorPoint') return val(tf.anchor, L, t);
    if (prop === 'rotation') return val(tf.rot, L, t);
    return val(tf[prop], L, t);
  }
  function controlKey(L, layerName, effect, param, n) {   // time of the control's Nth keyframe (1-based)
    const target = layerName ? findLayer(L.ci, layerName) : L;
    const p = target && control(target, effect, param);
    return p && p.k && p.k.length >= n ? p.k[n - 1].t : null;
  }
  function markerTime(L, type) {
    const m = (L.rec.markers || []).find((k) => k.acOn && k.acType === type);
    return m ? m.t : null;
  }
  function mech(x, value, L, t) {
    switch (x.kind) {
      case 'tree': return tree(x.tree, L, t, value);
      case 'const': return x.value;
      case 'condLink': return fxv(L, null, x.effect, x.cond, t) ? fxv(L, null, x.effect, x.param, t) : 0;
      case 'checkInvert': return fxv(L, null, x.effect, 1, t) === 1 ? x.on : x.off;
      case 'rectAnchor': {
        const r = textRect(L, x.timeCtl ? fxv(L, null, 'Time Control', 1, t) : t);
        return [r.left + r.width * x.fx, r.top + r.height * x.fy, 0];
      }
      case 'groupAlignCenter': {
        const r = textRect(L, fxv(L, null, 'Time Control', 1, t));
        const size = textStyle(L, t).size || 1;
        return [0, (r.top + r.height / 2) / size * 100];
      }
      case 'textMetric': {
        if (x.metric === 'chars') return currentText(L, t).length;
        if (x.metric === 'words') return (currentText(L, t).match(/\S+/g) || []).length;
        if (x.metric === 'lines') return currentText(L, t).split('\r').length;
        const r = visibleRect(L, x.timeCtl ? fxv(L, null, 'Time Control', 1, t) : t);
        const s = val(L.rec.tf.scale, L, t) || [100, 100];
        return x.metric === 'width' ? r.width * s[0] / 100 : r.height * s[1] / 100;
      }
      case 'layerAnchor': {
        const name = x.controlLayer ? `Edit Text ${Math.round(fxv(L, null, 'Control', 1, t))}` : x.layer;
        const target = findLayer(L.ci, name);
        return target ? val(target.rec.tf.anchor, target, t) : value;
      }
      case 'textBoxSize': return textBoxSize(L, t, x.strokeDist);
      case 'textBoxPos': return textBoxPos(L, t);
      case 'rectAnchorPct': {
        const b = shapeBounds(L, t);
        return [lerp(b.left, b.left + b.width, fxv(L, null, 'Text Box', 32, t) / 100),
          lerp(b.top, b.top + b.height, fxv(L, null, 'Text Box', 33, t) / 100)];
      }
      case 'shapeRef': {
        const item = shapeItem(L.rec.shapes, x.path);
        return item ? val(item[x.prop === 'position' ? 'pos' : 'size'], L, t) : value;
      }
      case 'shapeStrokeHalf': {
        const item = shapeItem(L.rec.shapes, x.path);
        return item ? (val(item.width, L, t) || 0) / 2 : 0;
      }
      case 'animatorProp': {
        const v = animatorProp(L, x.animator, x.prop, t);
        return x.invert100 ? 100 - v : v;
      }
      case 'fadeInOut': {
        if (t < L.rec.in + x.dur) return lerp(0, value, clamp01((t - L.rec.in) / x.dur));
        if (t > L.rec.out - x.dur) return lerp(value, 0, clamp01((t - (L.rec.out - x.dur)) / x.dur));
        return value;
      }
      case 'pinBox': {   // Pins & Boxes pin: percentage point of the target's box, mapped to comp space
        const target = findLayer(L.ci, x.layer);
        if (!target || target.ci !== L.ci) return value;
        const b = target.rec.kind === 'text' ? visibleRect(target, t) : shapeBounds(target, t);
        const px = fxv(L, null, x.effect, 1, t), py = fxv(L, null, x.effect, 2, t);
        const pt = apply(layerMatrix(target, t), b.left + b.width * px / 100, b.top + b.height * py / 100);
        return isArr(value) && value.length > 2 ? [pt[0], pt[1], value[2]] : pt;
      }
      case 'afterKey': {   // value until the control's Nth keyframe, then a constant
        const k = controlKey(L, x.layer, x.effect, x.param, x.key);
        return k !== null && t >= k ? x.value : value;
      }
      case 'blinkBetweenKeys': {
        const a = controlKey(L, x.layer, x.effect, x.param, x.from), b = controlKey(L, x.layer, x.effect, x.param, x.to);
        if (a === null || b === null || t < a || t >= b) return value;
        return Math.floor(t * x.rate + 1e-9) % 2 === 0 ? 100 : 0;
      }
      case 'acValue': {
        if (x.dir === 'in') { const tt = markerTime(L, '1'); return tt !== null && t < tt ? x.value : value; }
        const tt = markerTime(L, '2'); return tt !== null && t >= tt ? x.value : value;
      }
      default: return value;
    }
  }
  function shapeItem(items, path) {
    let list = items, found = null;
    for (const name of path) {
      found = (list || []).find((i) => i.name === name);
      if (!found) return null;
      list = found.items;
    }
    return found;
  }

  // ---------------------------------------------------------- text
  function editOverride(L) {
    if (!inputs || L.ci !== L.ci.root) return null;
    const idx = inputs.textLayers.indexOf(L.rec.name);
    const v = idx >= 0 ? inputs[TEXT_KEYS[idx]] : '';
    return v ? v.replace(/\n/g, '\r') : null;   // '' keeps the source sample text
  }
  function sourceLayer(L, t) {
    const s = L.rec.source;
    if (!s) return null;
    const name = s.control ? `Edit Text ${Math.max(1, Math.round(fxv(L, null, 'Control', 1, t)) || 1)}` : s.layer;
    const found = findLayer(L.ci, name);
    // A precomp layer that reads a same-named layer means the one in an outer comp, never itself.
    return found === L ? (L.ci.parent ? findLayer(L.ci.parent, name) : null) : found;
  }
  function rawText(L) {
    const o = editOverride(L);
    return o != null ? o : L.rec.doc.text;
  }
  function currentText(L, t) {
    const key = `txt|${uidOf(L)}|${t}`;
    if (frameCache.has(key)) return frameCache.get(key);
    let out = rawText(L);
    const s = L.rec.source;
    if (s) {
      const src = sourceLayer(L, t);
      const F = src ? rawText(src) : '';
      if (s.typing) {
        const a = fxv(L, null, s.typing.effect, s.typing.param, t);
        const n = s.typing.floor ? Math.floor(lerp(0, F.length, clamp01(a / 100))) : Math.round(lerp(0, F.length, clamp01(a / 100)));
        out = F.substring(0, n) + s.typing.cursor;
      } else {
        let res = null;
        const T = s.index === 'name'
          ? parseInt((/\d+/.exec(L.rec.name) || /\d+/.exec(L.ci.comp.name) || ['1'])[0], 10)
          : Math.round(fxv(L, null, 'Select', 1, t)) || 1;
        const I = T - 1;
        if (s.pick === 'all') res = F;
        else if (s.pick === 'char') res = I >= 0 && I < F.length ? F.substr(I, 1) : null;
        else if (s.pick === 'word') res = (F.match(/\S+/g) || [])[I] ?? null;
        else res = F.split(/\r\n|\r|\n/)[I] ?? null;
        if (res === null) out = '';
        else {
          let v = res;
          if (s.repeat) {
            const vr = Math.max(1, Math.round(fxv(L, null, 'Repeat', 1, t)) || 1);
            v = Array(vr).fill(v).join('\r');
          }
          if (s.symbol) {
            const si = Math.round(fxv(L, null, 'Symbol', 1, t));
            if (si > 0 && si <= SYMBOLS.length) v += SYMBOLS[si - 1];
          }
          if ('tileDefault' in s) {
            let mode = s.tileDefault;
            if (s.tileDefaultRef) mode = fxv(L, s.tileDefaultRef.layer, s.tileDefaultRef.effect, s.tileDefaultRef.param, t);
            if (control(L, 'Tile Mode', 1)) mode = Math.round(fxv(L, null, 'Tile Mode', 1, t));
            const hName = control(L, 'Horizontal Tile', 1) ? 'Horizontal Tile' : 'Horizantal Tile';
            const words = Math.max(1, Math.round(control(L, hName, 1) ? fxv(L, null, hName, 1, t) : 1));
            const lines = Math.max(1, Math.round(control(L, 'Vertical Tile', 1) ? fxv(L, null, 'Vertical Tile', 1, t) : 1));
            const active = s.tileTrailingBreak ? (t !== 0 && mode !== 0) : mode !== 0;
            if (active) {
              let str = '';
              for (let g = 1; g <= lines; g++) {
                for (let i = 1; i <= words; i++) str += v + s.sep;
                if (s.tileTrailingBreak || g < lines) str += '\r';
              }
              v = str;
            }
          }
          out = v;
        }
      }
    }
    frameCache.set(key, out);
    return out;
  }
  function textStyle(L, t) {
    const own = L.rec.doc;
    const src = L.rec.source ? sourceLayer(L, t) : null;
    // Derived layers copy the source's style (getStyleAt), justification included, so they overlay it exactly.
    const d = src ? { ...src.rec.doc } : own;
    let weight = d.weight;
    if (L.rec.source?.fontVar || L.rec.fontVar) {
      const w = inputs && inputs.weight > 0 ? inputs.weight : lerp(100, 900, clamp01(fxv(L, null, 'Weight Slider Control', 1, t) / 100));
      weight = Math.round(w);
    }
    return { ...d, weight };
  }
  function layout(L, t) {
    const text = currentText(L, t);
    const st = textStyle(L, t);
    const key = `${text}|${st.family}|${st.weight}|${st.style}|${st.size}|${st.tracking}|${st.leading}|${st.just}|${st.allCaps}`;
    if (layoutCache.has(key)) return layoutCache.get(key);
    const shown = st.allCaps ? text.toUpperCase() : text;
    measureCtx.font = `${st.style} ${st.weight} ${st.size}px ${FAMILY_STACK[st.family] || 'sans-serif'}`;
    const track = (st.tracking || 0) / 1000 * st.size;
    const leading = st.leading || st.size * 1.2;
    const glyphs = [];
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    let word = -1, charIdx = 0, nonSpace = 0;
    shown.split('\r').forEach((line, li) => {
      const chars = Array.from(line);
      const adv = [];
      let prev = 0;
      for (let i = 0; i < chars.length; i++) {
        const w = measureCtx.measureText(chars.slice(0, i + 1).join('')).width;
        adv.push(prev); prev = w;
      }
      const width = prev + track * Math.max(0, chars.length - 1);
      const x0 = st.just === 'center' ? -width / 2 : st.just === 'right' ? -width : 0;
      const y = li * leading;
      let inWord = false;
      chars.forEach((ch, i) => {
        const space = /\s/.test(ch);
        if (!space && !inWord) word++;
        inWord = !space;
        const x = x0 + adv[i] + track * i;
        const w = measureCtx.measureText(ch).width;
        glyphs.push({ ch, x, y, w, line: li, word: space ? -1 : word, idx: charIdx, ns: space ? -1 : nonSpace, space });
        charIdx++; if (!space) nonSpace++;
      });
      charIdx++;   // the line break is a character in AE's text index
      if (line.trim()) {
        const m = measureCtx.measureText(line);
        left = Math.min(left, x0 - m.actualBoundingBoxLeft);
        right = Math.max(right, x0 + m.actualBoundingBoxRight + track * Math.max(0, chars.length - 1));
        top = Math.min(top, y - m.actualBoundingBoxAscent);
        bottom = Math.max(bottom, y + m.actualBoundingBoxDescent);
      }
    });
    const rect = left === Infinity ? { left: 0, top: 0, width: 0, height: 0 }
      : { left, top, width: right - left, height: bottom - top };
    const out = { glyphs, rect, style: st, words: word + 1, lines: shown.split('\r').length, chars: charIdx - 1, nonSpace };
    if (layoutCache.size > 4000) layoutCache.clear();
    layoutCache.set(key, out);
    return out;
  }
  function textRect(L, t) {
    if (!L.rec.doc) return { left: 0, top: 0, width: 0, height: 0 };
    return layout(L, t).rect;
  }
  function textBoxSize(L, t, strokeDist) {
    const P = L.rec.parent ? L.ci.byId.get(L.rec.parent) : null;
    const b = P ? visibleRect(P, t) : { width: 0, height: 0 };
    const f = (i) => fxv(L, null, 'Text Box', i, t);
    const type = f(1), ML = f(23), MR = f(24), MT = f(25), MB = f(26);
    let w = type === 4 ? 0 : b.width + ML + MR, h = type === 3 ? 0 : b.height + MT + MB;
    if (type === 2) { const m = Math.max(b.width, b.height); w = m + ML + MR; h = m + MT + MB; }
    const uni = f(29) || 1;
    const d = strokeDist ? f(12) : 0;
    return [w * f(30) / 100 * uni + d, h * f(31) / 100 * uni + d];
  }
  function textBoxPos(L, t) {
    const P = L.rec.parent ? L.ci.byId.get(L.rec.parent) : null;
    const b = P ? visibleRect(P, t) : { left: 0, top: 0, width: 0, height: 0 };
    const f = (i) => fxv(L, null, 'Text Box', i, t);
    const s = [f(30), f(31)];
    const ML = f(23) / 2 / 100 * s[0], MR = f(24) / 2 / 100 * s[0], MT = f(25) / 2 / 100 * s[1], MB = f(26) / 2 / 100 * s[1];
    const a = val(L.rec.tf.anchor, L, t) || [0, 0];
    const type = f(1);
    let p;
    if (type === 1) p = [b.left + b.width / 2, b.top + b.height / 2];
    else if (type === 2) p = b.width > b.height ? [b.left + b.width / 2, b.top + b.height / 1.333] : [b.left + b.height / 2, b.top + b.height / 2];
    else if (type === 3) p = [b.left + b.width / 2, b.top + b.height];
    else p = [b.left + b.width, b.top + b.height / 2];
    return [a[0] + p[0] - ML + MR + b.width * f(34) / 100, a[1] + p[1] - MT + MB + b.height * f(35) / 100];
  }

  // ---------------------------------------------------------- selectors
  function unitsOf(g, basedOn, lay) {
    if (basedOn === 3) return { i: g.word, n: lay.words };
    if (basedOn === 4) return { i: g.line, n: lay.lines };
    if (basedOn === 2) return { i: g.ns, n: lay.nonSpace };
    return { i: g.idx, n: lay.chars };
  }
  function shapeValue(shape, u) {   // u = unit centre position within [0,1] of the range
    if (shape === 2) return clamp01(u);
    if (shape === 3) return 1 - clamp01(u);
    if (u < 0 || u > 1) return 0;
    if (shape === 4) return 1 - Math.abs(2 * u - 1);
    if (shape === 5) return Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2));
    if (shape === 6) return (1 - Math.cos(2 * Math.PI * u)) / 2;
    return 1;
  }
  function easeShape(v, hi, lo) {   // AE Ease High / Ease Low, approximated with a bezier
    if (!hi && !lo) return v;
    const h = hi / 100, l = lo / 100;
    const [x1, y1] = l >= 0 ? [l, 0] : [0, -l];
    const [x2, y2] = h >= 0 ? [1 - h, 1] : [1, 1 + h];
    return bezier1(Math.min(1, x1), Math.min(1, y1), Math.max(0, x2), Math.max(0, y2), clamp01(v));
  }
  function acState(L, sel, t) {
    const ac = sel.ac;
    const inT = markerTime(L, '1'), outT = markerTime(L, '2');
    let fade = null;
    if (ac.dir === 'in' && inT !== null && t < inT) {
      const d = inT - L.rec.in;
      fade = 1 - (d <= 0 ? 0 : clamp01((t - L.rec.in) / d));
    } else if (ac.dir === 'out' && outT !== null && t >= outT) {
      const d = L.rec.out - outT - 1 / FPS;
      fade = d <= 0 ? 1 : clamp01((t - outT) / d);
    }
    if (fade === null) return null;
    const names = L.rec.ctlNames[ac.ctl] || {};
    const rev = names['Reversed Order'] ? fxv(L, null, ac.ctl, names['Reversed Order'], t) : 0;
    const strength = names['Easing Strength'] ? fxv(L, null, ac.ctl, names['Easing Strength'], t) : 10;
    const ease = Math.pow(clamp01(fade), (Math.min(1000, Math.max(0, strength)) + 6) / 6);
    return { rev, ease };
  }
  function rangeSelection(L, sel, lay, t) {
    const units = unitsOf({ idx: 0, word: 0, line: 0, ns: 0 }, val(sel.basedOn, L, t), lay).n;
    const basedOn = val(sel.basedOn, L, t);
    let s0, e0, mode = val(sel.mode, L, t);
    const ac = sel.ac ? acState(L, sel, t) : null;
    const byIndex = val(sel.units, L, t) === 2;
    const len = sel.ac && sel.ac.len100 ? 100 : currentText(L, t).length;
    if (byIndex) {
      let is = val(sel.istart, L, t), ie = val(sel.iend, L, t);
      if (ac) {
        is = ac.rev === 1 ? ac.ease * len : len;
        ie = ac.rev === 0 ? (1 - ac.ease) * len : len;
        mode = ac.rev === 0 ? 1 : 2;
      }
      const off = val(sel.ioffset, L, t);
      s0 = is + off; e0 = ie + off;
    } else {
      let ps = val(sel.start, L, t), pe = val(sel.end, L, t);
      if (ac) {
        ps = ac.rev === 1 ? ac.ease * len : len;
        pe = ac.rev === 0 ? (1 - ac.ease) * len : len;
        mode = ac.rev === 0 ? 1 : 2;
      }
      const off = val(sel.offset, L, t);
      s0 = (ps + off) / 100 * units; e0 = (pe + off) / 100 * units;
    }
    if (s0 > e0) [s0, e0] = [e0, s0];
    const shape = val(sel.shape, L, t), smooth = val(sel.smooth, L, t);
    const amount = val(sel.amount, L, t) / 100;
    const hi = val(sel.easeHigh, L, t), lo = val(sel.easeLow, L, t);
    let order = null;
    if (val(sel.random, L, t)) {
      const seed = val(sel.seed, L, t) | 0;
      order = Array.from({ length: units }, (_, i) => i).sort((a, b) => hash(seed, a, 7) - hash(seed, b, 7));
    }
    const valueOf = (i0) => {
      if (i0 < 0) return 0;
      const i = order ? order[i0] ?? i0 : i0;
      let v;
      if (shape === 1) {
        const cover = Math.max(0, Math.min(i + 1, e0) - Math.max(i, s0));
        v = smooth === 0 ? (i + 0.5 >= s0 && i + 0.5 < e0 ? 1 : 0) : clamp01(cover);
      } else {
        v = e0 - s0 <= 0 ? (shape === 2 ? (i + 0.5 >= e0 ? 1 : 0) : shape === 3 ? (i + 0.5 < s0 ? 1 : 0) : 0)
          : shapeValue(shape, (i + 0.5 - s0) / (e0 - s0));
      }
      return easeShape(v, hi, lo) * amount;
    };
    return { mode, valueOf: (g) => valueOf(unitsOf(g, basedOn, lay).i) };
  }
  function wordTargetEase(L, t, idx) {
    const p = control(L, 'Select Word', 1);
    const target = Math.round(val(p, L, t));
    if (idx > target) return 100;
    if (idx < target) return 0;
    let change = 0;
    for (let tt = t; tt >= 0; tt -= 1 / FPS) {
      if (Math.round(val(p, L, tt)) !== idx) { change = tt + 1 / FPS; break; }
    }
    const u = clamp01((t - change) / 0.6);
    return 100 - 100 * bezier1(0.1, 0, 0, 1, u);
  }
  function exprSelection(L, sel, lay, t) {
    const basedOn = val(sel.basedOn, L, t);
    const total = unitsOf({ idx: 0, word: 0, line: 0, ns: 0 }, basedOn, lay).n;
    const text = currentText(L, t);
    const words = Math.max(1, (text.replace(/\r/g, ' ').match(/\S+/g) || []).length);
    const valueOf = (g) => {
      const u = unitsOf(g, basedOn, lay);
      if (u.i < 0) return 0;
      const ti = u.i + 1;
      switch (sel.kind) {
        case 'lastUnit': return ti === total ? 1 : 0;
        case 'wordPick': {
          if (fxv(L, null, 'Default', 1, t) === 1) return 0;
          const pick = Math.round(fxv(L, null, 'Select', 1, t));
          // Keep the source expression's JS remainder: word 1 maps to 0 (Select 0), word 2 to 1.
          // A true modulo maps word 1 to `words`, so no selector matches it and it vanishes.
          const r = ((ti - 2) % words) + 1;
          const hit = r === pick;
          return fxv(L, null, 'Invert', 1, t) === 1 ? (hit ? 1 : 0) : (hit ? 0 : 1);
        }
        case 'wordTarget': {
          const target = Math.round(fxv(L, null, 'Select Word', 1, t));
          const cur = total === words ? (ti - 1) % words + 1 : (ti - 1) % total + 1;
          const hit = cur === target;
          return sel.mode === 1 ? (hit ? 0 : 1) : (hit ? 1 : 0);
        }
        case 'wordTargetEase': return wordTargetEase(L, t, ti) / 100;
        case 'typewriter': {
          if (!fxv(L, null, 'Active', 1, t)) return 0;
          const progress = fxv(L, null, 'Progress', 1, t);
          const style = Math.round(fxv(L, null, 'Style', 1, t));
          let cur = ti;
          if (style === 2) cur = total - ti + 1;
          else if (style === 3) cur = 1 + Math.floor(hash(ti, 1, 3) * total);
          else if (style === 4) cur = Math.floor(Math.abs(ti - (total / 2 + 0.5))) + 1;
          return cur <= (progress / 100) * total ? 0 : 1;
        }
        default: return 1;
      }
    };
    return { mode: 1, valueOf };
  }
  function wigglySelection(L, sel, lay, t) {
    const basedOn = val(sel.basedOn, L, t);
    const freq = val(sel.freq, L, t), corr = clamp01(val(sel.corr, L, t) / 100);
    const max = val(sel.max, L, t) / 100, min = val(sel.min, L, t) / 100;
    const seed = sel.seedFromTime ? Math.round(t * FPS) + 10 : (val(sel.seed, L, t) | 0);
    const phase = t * freq + val(sel.tphase, L, t) / 360;
    const k = Math.floor(phase), f = phase - k, sm = f * f * (3 - 2 * f);
    const rnd = (unit, step) => hash(seed, unit, step) * 2 - 1;
    const valueOf = (g) => {
      const u = unitsOf(g, basedOn, lay).i;
      if (u < 0) return 0;
      const own = lerp(rnd(u + 1, k), rnd(u + 1, k + 1), sm), shared = lerp(rnd(0, k), rnd(0, k + 1), sm);
      const w = lerp(own, shared, corr);
      return lerp(min, max, (w + 1) / 2);
    };
    return { mode: val(sel.mode, L, t), valueOf };
  }
  function combine(mode, prev, cur, first) {
    if (first) return mode === 2 ? 1 - cur : cur;
    switch (mode) {
      case 2: return prev - cur;
      case 3: return prev * cur;
      case 4: return Math.min(prev, cur);
      case 5: return Math.max(prev, cur);
      case 6: return Math.abs(prev - cur);
      default: return Math.min(1, prev + cur);
    }
  }

  // ---------------------------------------------------------- text animators
  // Per-glyph animator state for one layer at one time (shared by rendering and box measuring).
  function glyphState(L, t, lay) {
    const st = lay.style;
    const n = lay.glyphs.length;
    const G = lay.glyphs.map((g) => ({ g, dx: 0, dy: 0, sx: 1, sy: 1, r: 0, op: 1, fill: st.fill ? st.fill.slice(0, 3) : null,
      fo: 1, stroke: st.stroke ? st.stroke.slice(0, 3) : null, sw: st.stroke ? st.sw : 0, so: 1, trk: 0 }));
    for (const a of L.rec.animators || []) {
      if (!a.on) continue;
      const sels = [];
      for (const s of a.sel) {
        if (s.kind === 'range') sels.push(rangeSelection(L, s, lay, t));
        else if (s.kind === 'wiggly') sels.push(wigglySelection(L, s, lay, t));
        else sels.push(exprSelection(L, s, lay, t));
      }
      const P = {};
      for (const [k, p] of Object.entries(a.props)) P[k] = val(p, L, t);
      for (let i = 0; i < n; i++) {
        const q = G[i];
        let s = 1;
        sels.forEach((sel, j) => { s = combine(sel.mode, s, sel.valueOf(q.g), j === 0); });
        if (!sels.length) s = 1;
        if (!s) continue;
        if (P.position) { q.dx += P.position[0] * s; q.dy += P.position[1] * s; }
        if (P.scale) { q.sx *= 1 + (P.scale[0] / 100 - 1) * s; q.sy *= 1 + (P.scale[1] / 100 - 1) * s; }
        if (P.rotation) q.r += P.rotation * s;
        if (P.opacity !== undefined) q.op *= clamp01(1 + (P.opacity / 100 - 1) * s);
        if (P.fillColor && q.fill) q.fill = q.fill.map((c, d) => lerp(c, P.fillColor[d], clamp01(s)));
        else if (P.fillColor) q.fill = P.fillColor.slice(0, 3);
        if (P.fillOpacity !== undefined) q.fo *= clamp01(1 + (P.fillOpacity / 100 - 1) * s);
        if (P.strokeColor) q.stroke = (q.stroke || P.strokeColor.slice(0, 3)).map((c, d) => lerp(c, P.strokeColor[d], clamp01(s)));
        if (P.strokeWidth !== undefined && P.strokeWidth) q.sw = lerp(q.sw, P.strokeWidth, clamp01(s));
        if (P.strokeOpacity !== undefined) q.so *= clamp01(1 + (P.strokeOpacity / 100 - 1) * s);
        if (P.tracking) q.trk += P.tracking / 1000 * st.size * s;
      }
    }
    return G;
  }
  // Box rigs size to the glyphs still drawn: glyphs scaled to zero by an animator drop out,
  // as they do in AE's source rect. Falls back to the full layout rect when nothing is hidden.
  let measuringDepth = 0;
  function visibleRect(L, t) {
    if (!L.rec.doc) return { left: 0, top: 0, width: 0, height: 0 };
    const lay = layout(L, t);
    if (!(L.rec.animators || []).some((a) => a.on) || measuringDepth > 2) return lay.rect;
    const key = `vr|${uidOf(L)}|${t}`;
    if (frameCache.has(key)) return frameCache.get(key);
    measuringDepth++;
    let G;
    try { G = glyphState(L, t, lay); } finally { measuringDepth--; }
    const shown = G.filter((q) => !q.g.space && Math.abs(q.sx) > 1e-3 && Math.abs(q.sy) > 1e-3);
    let rect = lay.rect;
    // AE's source rect is measured after text animators: hidden (zero-scale) glyphs drop out and
    // animator position/scale offsets move the box with the glyphs.
    const moved = shown.some((q) => q.dx || q.dy || q.sx !== 1 || q.sy !== 1);
    if (shown.length && (moved || shown.length < G.filter((q) => !q.g.space).length)) {
      // Ink of each visible glyph, measured in the layer's own font (same metrics as layout()).
      const st = lay.style;
      measureCtx.font = `${st.style} ${st.weight} ${st.size}px ${FAMILY_STACK[st.family] || 'sans-serif'}`;
      const ga = val(L.rec.groupAlign, L, t) || [0, 0];
      const visible = new Set(shown);
      let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
      let line = -1, shift = 0;
      for (const q of G) {   // same placement as renderText: tracking shift, then scale about the grouping pivot
        if (q.g.line !== line) { line = q.g.line; shift = 0; }
        const x = q.g.x + shift; shift += q.trk;
        if (!visible.has(q)) continue;
        const m = measureCtx.measureText(q.g.ch);
        const px = x + q.g.w / 2 + ga[0] / 100 * st.size, py = q.g.y + ga[1] / 100 * st.size;
        const xs = [x - m.actualBoundingBoxLeft, x + m.actualBoundingBoxRight].map((v) => px + q.dx + (v - px) * q.sx);
        const ys = [q.g.y - m.actualBoundingBoxAscent, q.g.y + m.actualBoundingBoxDescent].map((v) => py + q.dy + (v - py) * q.sy);
        left = Math.min(left, ...xs); right = Math.max(right, ...xs);
        top = Math.min(top, ...ys); bottom = Math.max(bottom, ...ys);
      }
      rect = { left, top, width: right - left, height: bottom - top };
    }
    frameCache.set(key, rect);
    return rect;
  }

  // ---------------------------------------------------------- text layer render
  function renderText(L, t, M, layerFill, inMask) {
    const lay = layout(L, t);
    if (!lay.glyphs.length) return '';
    const st = lay.style;
    const G = glyphState(L, t, lay);
    // tracking animators push the following characters along the line
    let shift = 0, line = -1;
    const ga = val(L.rec.groupAlign, L, t) || [0, 0];
    const fam = FAMILY_STACK[st.family] || 'sans-serif';
    let out = `<g transform="${fmt(M)}" font-family="${escapeXml(fam)}" font-size="${st.size}" font-weight="${st.weight}" font-style="${st.style}">`;
    for (const q of G) {
      const g = q.g;
      if (g.line !== line) { line = g.line; shift = 0; }
      const x = g.x + shift; shift += q.trk;
      if (g.space || q.op <= 0.001) continue;
      const px = x + g.w / 2 + ga[0] / 100 * st.size, py = g.y + ga[1] / 100 * st.size;
      let m = tr(x + q.dx, g.y + q.dy);
      if (q.r || q.sx !== 1 || q.sy !== 1) {
        m = mul(tr(px + q.dx, py + q.dy), mul(rot(q.r), mul(sc(q.sx, q.sy), tr(-px + x, -py + g.y))));
      }
      const fill = layerFill || (q.fill ? hexOf(q.fill) : 'none');
      const stroke = q.sw > 0 && q.stroke ? (layerFill || hexOf(q.stroke)) : null;
      if (fill === 'none' && !stroke) continue;
      if (q.fo <= 0.001 && (!stroke || q.so <= 0.001)) continue;
      out += `<text transform="${fmt(m)}" fill="${fill}"${q.fo < 1 ? ` fill-opacity="${+q.fo.toFixed(3)}"` : ''}`
        + (stroke ? ` stroke="${stroke}" stroke-width="${+q.sw.toFixed(2)}" stroke-linejoin="round"${q.so < 1 ? ` stroke-opacity="${+q.so.toFixed(3)}"` : ''}` : '')
        + `${q.op < 1 ? ` opacity="${+q.op.toFixed(3)}"` : ''}${inMask ? '' : ' class="kt-glyph"'}>${escapeXml(g.ch)}</text>`;
    }
    return out + '</g>';
  }

  // ---------------------------------------------------------- shapes
  function rectPath(pos, size, r) {
    const w = Math.abs(size[0]), h = Math.abs(size[1]);
    const x = pos[0] - w / 2, y = pos[1] - h / 2;
    const rr = Math.max(0, Math.min(r || 0, w / 2, h / 2));
    if (!rr) return `M${x} ${y}h${w}v${h}h${-w}Z`;
    return `M${x + rr} ${y}h${w - 2 * rr}a${rr} ${rr} 0 0 1 ${rr} ${rr}v${h - 2 * rr}a${rr} ${rr} 0 0 1 ${-rr} ${rr}`
      + `h${-(w - 2 * rr)}a${rr} ${rr} 0 0 1 ${-rr} ${-rr}v${-(h - 2 * rr)}a${rr} ${rr} 0 0 1 ${rr} ${-rr}Z`;
  }
  function groupMatrix(item, L, t) {
    const a = val(item.anchor, L, t) || [0, 0], p = val(item.pos, L, t) || [0, 0], s = val(item.scale, L, t) || [100, 100];
    return mul(tr(p[0], p[1]), mul(rot(val(item.rot, L, t) || 0), mul(sc(s[0] / 100, s[1] / 100), tr(-a[0], -a[1]))));
  }
  function renderShapes(items, L, t, layerFill) {
    const paths = [];
    let offset = 0;
    for (const it of items) if (it.kind === 'offset') offset += val(it.amount, L, t) || 0;
    for (const it of items) {
      if (it.kind === 'rect') {
        const size = val(it.size, L, t), pos = val(it.pos, L, t);
        if (!size) continue;
        paths.push(rectPath(pos, [Math.abs(size[0]) + 2 * offset, Math.abs(size[1]) + 2 * offset], (val(it.round, L, t) || 0) + offset));
      } else if (it.kind === 'ellipse') {
        const s = val(it.size, L, t), p = val(it.pos, L, t);
        const rx = Math.abs(s[0]) / 2 + offset, ry = Math.abs(s[1]) / 2 + offset;
        paths.push(`M${p[0] - rx} ${p[1]}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`);
      }
    }
    const d = paths.join('');
    // Shapes sized by a Text Box rig are the text's container; tagged so layout checks can find them.
    const boxTag = items.some((it) => it.kind === 'rect' && it.size && it.size.x && it.size.x.kind === 'textBoxSize') ? ' data-kt-box="1"' : '';
    let out = '';
    for (let i = items.length - 1; i >= 0; i--) {   // lower items render first (AE stacking)
      const it = items[i];
      if (it.kind === 'group') {
        const op = (val(it.opacity, L, t) ?? 100) / 100;
        if (op <= 0) continue;
        out += `<g transform="${fmt(groupMatrix(it, L, t))}"${op < 1 ? ` opacity="${+op.toFixed(3)}"` : ''}>${renderShapes(it.items, L, t, layerFill)}</g>`;
      } else if (it.kind === 'fill' && d) {
        const op = (val(it.opacity, L, t) ?? 100) / 100;
        if (op > 0) out += `<path d="${d}"${boxTag} fill="${layerFill || hexOf(val(it.color, L, t))}"${op < 1 ? ` fill-opacity="${+op.toFixed(3)}"` : ''}/>`;
      } else if (it.kind === 'stroke' && d) {
        const op = (val(it.opacity, L, t) ?? 100) / 100, w = val(it.width, L, t) || 0;
        if (op <= 0 || w <= 0) continue;
        const dash = it.dash ? val(it.dash, L, t) : 0, gap = it.gap ? val(it.gap, L, t) : 0;
        out += `<path d="${d}"${boxTag} fill="none" stroke="${layerFill || hexOf(val(it.color, L, t))}" stroke-width="${+w.toFixed(2)}"`
          + `${op < 1 ? ` stroke-opacity="${+op.toFixed(3)}"` : ''}${dash > 0 ? ` stroke-dasharray="${dash} ${gap || dash}"` : ''}/>`;
      }
    }
    return out;
  }
  function shapeBounds(L, t) {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const walk = (items, M) => {
      for (const it of items || []) {
        if (it.kind === 'group') walk(it.items, mul(M, groupMatrix(it, L, t)));
        else if (it.kind === 'rect' || it.kind === 'ellipse') {
          const s = val(it.size, L, t), p = val(it.pos, L, t);
          if (!s) continue;
          for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const [x, y] = apply(M, p[0] + cx * Math.abs(s[0]) / 2, p[1] + cy * Math.abs(s[1]) / 2);
            left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
          }
        }
      }
    };
    walk(L.rec.shapes, I2);
    return left === Infinity ? { left: 0, top: 0, width: 0, height: 0 } : { left, top, width: right - left, height: bottom - top };
  }

  // ---------------------------------------------------------- layers
  function uidOf(L) { if (!L.uid) L.uid = ++uid; return L.uid; }
  function layerMatrix(L, t, depth = 0) {
    const key = `m|${uidOf(L)}|${t}`;
    if (frameCache.has(key)) return frameCache.get(key);
    const tf = L.rec.tf;
    const pos = transformValue(L, 'position', t) || [0, 0];
    const a = val(tf.anchor, L, t) || [0, 0];
    const s = val(tf.scale, L, t) || [100, 100];
    let sx = s[0] / 100, sy = s[1] / 100;
    if (L.rec.threeD) {   // orthographic stand-in for 3D X/Y rotation
      sx *= Math.cos((val(tf.ry, L, t) || 0) * Math.PI / 180);
      sy *= Math.cos((val(tf.rx, L, t) || 0) * Math.PI / 180);
    }
    let m = mul(tr(pos[0], pos[1]), mul(rot(val(tf.rot, L, t) || 0), mul(sc(sx, sy), tr(-a[0], -a[1]))));
    if (L.rec.parent && depth < 12) {
      const P = L.ci.byId.get(L.rec.parent);
      if (P) m = mul(layerMatrix(P, t, depth + 1), m);
    }
    frameCache.set(key, m);
    return m;
  }
  function effectMatrix(L, t) {
    let m = I2;
    let opacity = 1;
    for (const f of L.rec.fx) {
      if (f.type !== 'transform') continue;
      const p = (i) => val(f.p[i], L, t);
      const a = p(1) || [0, 0], pos = p(2) || [0, 0];
      const uniform = p(11);
      const sy = (p(3) ?? 100) / 100, sx = uniform ? sy : (p(4) ?? 100) / 100;
      m = mul(m, mul(tr(pos[0], pos[1]), mul(rot(p(7) || 0), mul(skewM(p(5) || 0, p(6) || 0), mul(sc(sx, sy), tr(-a[0], -a[1]))))));
      opacity *= (p(8) ?? 100) / 100;
    }
    return { m, opacity };
  }
  function filterFor(L, t) {
    const parts = [];
    for (const f of L.rec.fx) {
      const p = (i) => val(f.p[i], L, t);
      if (f.type === 'blur') {
        const r = p(1) || 0, it = p(2) || 1, dims = p(3) || 1;
        if (r <= 0) continue;
        const sd = r * Math.sqrt(it / 3);
        parts.push(`<feGaussianBlur stdDeviation="${dims === 3 ? 0 : sd.toFixed(2)} ${dims === 2 ? 0 : sd.toFixed(2)}"/>`);
      } else if (f.type === 'shadow') {
        const c = p(1), op = p(2) ?? 0.5, dir = (p(3) || 0) * Math.PI / 180, dist = p(4) || 0, soft = p(5) || 0;
        const alpha = op > 1 ? op / 255 : op;
        if (alpha <= 0) continue;
        parts.push(`<feDropShadow dx="${(Math.sin(dir) * dist).toFixed(2)}" dy="${(-Math.cos(dir) * dist).toFixed(2)}" stdDeviation="${(soft / 2.5).toFixed(2)}" flood-color="${hexOf(c)}" flood-opacity="${clamp01(alpha).toFixed(3)}"/>`);
      } else if (f.type === 'glow') {   // AE Glow stand-in: blurred copy added under the source
        const radius = p(3) || 0, intensity = p(4) || 1;
        if (radius <= 0) continue;
        parts.push(`<feGaussianBlur in="SourceGraphic" stdDeviation="${(radius / 3).toFixed(2)}" result="gb"/><feComponentTransfer in="gb" result="gl"><feFuncA type="linear" slope="${Math.min(4, intensity).toFixed(2)}"/></feComponentTransfer><feMerge><feMergeNode in="gl"/><feMergeNode in="SourceGraphic"/></feMerge>`);
      }
    }
    if (!parts.length) return '';
    const id = `f${defs.length}`;
    // Chain each primitive on the previous result.
    defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" filterUnits="objectBoundingBox" color-interpolation-filters="sRGB">${parts.join('')}</filter>`);
    return id;
  }
  function layerFillOverride(L, t) {
    let c = null;
    for (const f of L.rec.fx) if (f.type === 'fill') { const v = val(f.p[2], L, t); if (isArr(v) && (val(f.p[5], L, t) ?? 1) > 0) c = hexOf(v); }
    return c;
  }
  const BLEND = { ADD: 'plus-lighter', SCREEN: 'screen', MULTIPLY: 'multiply', OVERLAY: 'overlay', LIGHTEN: 'lighten',
    DARKEN: 'darken', DIFFERENCE: 'difference', COLOR_DODGE: 'color-dodge', SOFT_LIGHT: 'soft-light', HARD_LIGHT: 'hard-light' };
  function active(L, t) { return t >= L.rec.in && t < L.rec.out; }
  function renderLayer(L, t, inMask) {
    if (!active(L, t)) return '';
    const op = clamp01((val(L.rec.tf.opacity, L, t) ?? 100) / 100);
    if (op <= 0) return '';
    const M = layerMatrix(L, t);
    const fxm = effectMatrix(L, t);
    const fill = layerFillOverride(L, t);
    let body = '';
    const kind = L.rec.kind;
    if (kind === 'text') body = renderText(L, t, mul(M, fxm.m), fill, inMask);
    else if (kind === 'shape') body = `<g transform="${fmt(mul(M, fxm.m))}">${renderShapes(L.rec.shapes, L, t, fill)}</g>`;
    else if (kind === 'solid') {
      const s = L.rec.solid;
      body = `<rect transform="${fmt(mul(M, fxm.m))}" width="${s.w}" height="${s.h}" fill="${fill || hexOf(s.color)}"/>`;
    } else if (kind === 'precomp') {
      const key = `ci|${uidOf(L)}`;
      if (!L.child) L.child = compInstance(L.rec.comp, L.ci, L.rec.st);
      const child = L.child;
      const clip = `c${defs.length}`;
      defs.push(`<clipPath id="${clip}"><rect width="${child.comp.w}" height="${child.comp.h}"/></clipPath>`);
      body = `<g transform="${fmt(mul(M, fxm.m))}"><g clip-path="url(#${clip})">${renderComp(child, t - L.rec.st, inMask)}</g></g>`;
      void key;
    } else return '';
    if (!body) return '';
    const filter = filterFor(L, t);
    const alpha = op * fxm.opacity;
    const blend = BLEND[L.rec.blend];
    let out = `<g${alpha < 1 ? ` opacity="${+alpha.toFixed(4)}"` : ''}${filter ? ` filter="url(#${filter})"` : ''}>${body}</g>`;
    if (L.rec.matte) {
      const src = L.ci.byId.get(L.rec.matte.layer);
      const matte = src ? renderLayer(src, t, true) : '';
      const id = `m${defs.length}`;
      const big = 'x="-20000" y="-20000" width="44000" height="44000"';
      if (L.rec.matte.mode === 'ALPHA_INVERTED') {
        defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" ${big} style="mask-type:luminance"><rect ${big} fill="#fff"/><g filter="url(#ktBlack)">${matte}</g></mask>`);
      } else if (L.rec.matte.mode === 'LUMA') {
        defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" ${big} style="mask-type:luminance">${matte}</mask>`);
      } else {
        defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" ${big} style="mask-type:alpha">${matte}</mask>`);
      }
      out = `<g mask="url(#${id})">${out}</g>`;
    }
    // The blend goes on the outermost wrapper: a mask isolates its group, so a blend inside
    // it would only mix with the empty group instead of the layers below.
    if (blend && !inMask) out = `<g style="mix-blend-mode:${blend}">${out}</g>`;
    return out;
  }
  function renderComp(ci, t, inMask) {
    // Walk top -> bottom to find the time each layer sees (Posterize Time adjustment layers).
    const layers = ci.comp.layers.map((rec) => ci.byId.get(rec.id));
    const times = [];
    let tt = t;
    for (const L of layers) {
      times.push(tt);
      if (L.rec.adjust && L.rec.enabled && active(L, t)) {
        const post = L.rec.fx.find((f) => f.type === 'posterize');
        if (post) { const rate = val(post.p[1], L, t) || FPS; tt = Math.floor(tt * rate + 1e-6) / rate; }
      }
    }
    let out = '';
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      if (L.rec.guide || !L.rec.enabled) continue;
      if (L.rec.adjust || L.rec.kind === 'adjust') {
        if (!active(L, t) || !out) continue;
        const filter = filterFor(L, times[i]);
        const offset = L.rec.fx.find((f) => f.type === 'offset');
        if (offset) {
          const c = val(offset.p[1], L, times[i]) || [ci.comp.w / 2, ci.comp.h / 2];
          const w = ci.comp.w;
          const dx = (((c[0] - w / 2) % w) + w) % w;
          out = `<g transform="translate(${dx.toFixed(2)} ${(c[1] - ci.comp.h / 2).toFixed(2)})">${out}</g><g transform="translate(${(dx - w).toFixed(2)} ${(c[1] - ci.comp.h / 2).toFixed(2)})">${out}</g>`;
        }
        if (filter) out = `<g filter="url(#${filter})">${out}</g>`;
        continue;
      }
      if (L.rec.blend === 'SILHOUETE_ALPHA' || L.rec.blend === 'SILHOUETTE_ALPHA') {
        // Silhouette Alpha: the layer draws nothing itself and cuts its alpha out of everything below it.
        if (!out) continue;
        const cut = renderLayer(L, times[i], true);   // mask mode: no blend style, no glyph class
        if (!cut) continue;
        const id = `s${defs.length}`;
        const big = 'x="-20000" y="-20000" width="44000" height="44000"';
        defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" ${big} style="mask-type:luminance"><rect ${big} fill="#fff"/><g filter="url(#ktBlack)">${cut}</g></mask>`);
        out = `<g mask="url(#${id})">${out}</g>`;
        continue;
      }
      out += renderLayer(L, times[i], inMask);
    }
    return out;
  }

  // ---------------------------------------------------------- public
  let root = null;
  function setInputs(next) {
    inputs = next;
    const variant = recipe.variants.find((v) => v.id === next.variant);
    root = compInstance(variant.comp, null, 0);
    frameCache = new Map();
  }
  function render(t) {
    frameCache = new Map();
    defs = ['<filter id="ktBlack"><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"/></filter>'];
    const body = renderComp(root, t, false);
    return { defs: defs.join(''), body };
  }
  return { setInputs, render };
}
