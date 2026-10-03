// Wind glyphs for one explorer layer: animated flow particles and wind barbs.
//
// Both draw at the layer's own height. Vertices carry (lon, lat, height m)
// plus a local east/north offset in km (barb shapes; zero for particles);
// the shader projects them (flat map or globe, project.js GEO_GLSL) and
// applies the vertical exaggeration and a small lift so the glyphs sit just
// above their level's fill -- so the vex slider and the globe toggle move
// them with the level without rebuilding anything.
//
// Particles: each drifts through the wind field blended between the two
// real steps around the current time (the same A/B/t blend as the level
// mesh), in "flow time" -- a visual speed-up of real time, not a forecast --
// and leaves a short fading trail a few pixels wide. They restart at a
// random spot when they age out, leave the domain, or wander below ground.
//
// Barbs: standard meteorological barbs (staff toward where the wind comes
// from, 5 kt half / 10 kt full / 50 kt pennant), drawn from the nearer real
// step only -- a barb is a reading, so it is never interpolated.
import * as THREE from "three";
import { GEO_GLSL } from "./project.js";

const VERT = /* glsl */ `
${GEO_GLSL}
attribute vec4 rgba;
attribute vec2 offset;
uniform float vex; uniform float lift;
varying vec4 vCol;
void main() {
  vCol = rgba;
  vec3 p = geoPosition(position.y, position.x, position.z * 0.001 * vex + lift, offset);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FRAG = /* glsl */ `
varying vec4 vCol;
void main() {
  if (vCol.a < 0.01) discard;
  gl_FragColor = vCol;
}`;

function lineMaterial(lift, geo) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: { ...geo.uniforms, vex: { value: 120 }, lift: { value: lift } },
    transparent: true, depthWrite: false,
  });
}

// Bilinear sample of a row-major (lat j, lon i) field at fractional (fi, fj).
function bilinear(a, nlon, fi, fj) {
  const i = Math.floor(fi), j = Math.floor(fj), x = fi - i, y = fj - j;
  const k = j * nlon + i;
  return (a[k] * (1 - x) + a[k + 1] * x) * (1 - y) + (a[k + nlon] * (1 - x) + a[k + nlon + 1] * x) * y;
}

const M_PER_DEG = 111320;

// Particle streaks are drawn as instanced ribbons a fixed number of PIXELS
// wide (a GL line is always 1 px, too faint at basin scale): each instance
// is one trail segment; the shader projects both ends (flat or globe), then
// widens the segment sideways in screen space. Idea and look (pixel-width
// streaks, colour per level, brighter with speed) from the sibling Radar
// Volume Explorer's web/particles.js; normal alpha blending here rather than
// its additive glow, because this basemap is light and additive light
// washes out to white on it.
const RIBBON_VERT = /* glsl */ `
${GEO_GLSL}
attribute vec3 iA; attribute vec3 iB;      // segment ends: lon, lat, height (m)
attribute vec4 cA; attribute vec4 cB;      // colour + alpha at each end
uniform float vex; uniform float lift; uniform float width; uniform vec2 resolution;
varying vec4 vCol;
void main() {
  vec4 a = projectionMatrix * modelViewMatrix * vec4(geoPosition(iA.y, iA.x, iA.z * 0.001 * vex + lift, vec2(0.0)), 1.0);
  vec4 b = projectionMatrix * modelViewMatrix * vec4(geoPosition(iB.y, iB.x, iB.z * 0.001 * vex + lift, vec2(0.0)), 1.0);
  if (a.w <= 0.0 || b.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vCol = vec4(0.0); return; }
  vec2 sa = a.xy / a.w * resolution * 0.5, sb = b.xy / b.w * resolution * 0.5;   // pixels
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 c = position.x < 0.5 ? a : b;
  // Sideways by half the width, and a little along the segment so joints overlap.
  vec2 px = nrm * position.y * width * 0.5 + dir * (position.x - 0.5) * width * 0.5;
  c.xy += px / (resolution * 0.5) * c.w;
  gl_Position = c;
  vCol = position.x < 0.5 ? cA : cB;
}`;
const RIBBON_FRAG = /* glsl */ `
uniform float opacity;
varying vec4 vCol;
void main() {
  if (vCol.a * opacity < 0.01) discard;
  gl_FragColor = vec4(vCol.rgb, vCol.a * opacity);
}`;

// Shared by every layer's particles, so one set of controls styles them all.
export const PARTICLE_STYLE = {
  width: { value: 2.2 },                     // px
  opacity: { value: 0.9 },
  resolution: { value: new THREE.Vector2(1, 1) },
  speed: 1,                                  // x the base flow time
};

export class ParticleSystem {
  // grid: manifest.grid; geo: project.js makeGeo(); color: css
  constructor(grid, geo, { count = 3000, trail = 12, lift = 6, color = "#0d2233", renderOrder = 20 } = {}) {
    this.grid = grid;
    this.trail = trail;
    this.color = new THREE.Color(color);
    // Model seconds of drift per real second (x PARTICLE_STYLE.speed). Sized
    // for a basin-wide view: at 60 fps a 10 m/s wind moves ~15 km a frame, so
    // a 12-point trail is ~165 km long -- visible motion without particles
    // racing across the map.
    this.flowSeconds = 90000;
    this.lifetime = [3, 7];            // real seconds a particle lives
    const segs = trail - 1;
    this.maxCount = count;
    this.iA = new Float32Array(count * segs * 3);
    this.iB = new Float32Array(count * segs * 3);
    this.cA = new Float32Array(count * segs * 4);
    this.cB = new Float32Array(count * segs * 4);
    const geom = new THREE.InstancedBufferGeometry();
    // One quad per segment: x = 0 at end A, 1 at end B; y = -1/+1 across.
    geom.setAttribute("position", new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    for (const [name, arr, size] of [["iA", this.iA, 3], ["iB", this.iB, 3], ["cA", this.cA, 4], ["cB", this.cB, 4]]) {
      geom.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage));
    }
    this.geom = geom;
    this.material = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT, fragmentShader: RIBBON_FRAG,
      uniforms: {
        ...geo.uniforms, vex: { value: 120 }, lift: { value: lift },
        width: PARTICLE_STYLE.width, opacity: PARTICLE_STYLE.opacity, resolution: PARTICLE_STYLE.resolution,
      },
      transparent: true, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.fi = new Float32Array(count);
    this.fj = new Float32Array(count);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.hist = new Float32Array(count * trail * 3);   // lon, lat, h per trail point, head first
    this.count = count;
    this.setCount(count);
    this.seeded = false;
  }

  get object() { return this.mesh; }

  setCount(n) {
    this.count = Math.max(0, Math.min(this.maxCount, Math.round(n)));
    this.geom.instanceCount = this.count * (this.trail - 1);
  }

  _respawn(p, field) {
    const { nlat, nlon } = this.grid;
    for (let tries = 0; tries < 8; tries++) {
      this.fi[p] = Math.random() * (nlon - 1.001);
      this.fj[p] = Math.random() * (nlat - 1.001);
      if (!field || this._above(field, p)) break;
    }
    this.age[p] = 0;
    this.life[p] = this.lifetime[0] + Math.random() * (this.lifetime[1] - this.lifetime[0]);
    const [lon, lat] = this._lonlat(p);
    const h = field ? this._h(field, p) : 0;
    for (let k = 0; k < this.trail; k++) this.hist.set([lon, lat, h], (p * this.trail + k) * 3);
  }

  _lonlat(p) {
    const g = this.grid;
    return [g.lon0 + this.fi[p] * g.dlon, g.lat0 + this.fj[p] * g.dlat];
  }

  _blend(aA, aB, field, p) {
    const n = this.grid.nlon, fi = this.fi[p], fj = this.fj[p];
    const a = bilinear(aA, n, fi, fj);
    return field.t > 0 ? a + (bilinear(aB, n, fi, fj) - a) * field.t : a;
  }

  _h(field, p) { return field.hA ? this._blend(field.hA, field.hB, field, p) : 0; }

  _above(field, p) { return !field.oA || this._blend(field.oA, field.oB, field, p) >= 0.5; }

  // field: {uA, vA, uB, vB, hA?, hB?, oA?, oB?, t} (m/s, m, 0/1); dt: real s.
  update(dt, field) {
    const { nlat, nlon, lat0, dlat, dlon } = this.grid;
    const T = this.trail, segs = T - 1;
    if (!this.seeded) {
      for (let p = 0; p < this.maxCount; p++) { this._respawn(p, field); this.age[p] = Math.random() * this.life[p]; }
      this.seeded = true;
    }
    const sim = dt * this.flowSeconds * PARTICLE_STYLE.speed;
    const { r, g, b } = this.color;
    for (let p = 0; p < this.count; p++) {
      this.age[p] += dt;
      const u = this._blend(field.uA, field.uB, field, p);
      const v = this._blend(field.vA, field.vB, field, p);
      const lat = lat0 + this.fj[p] * dlat;
      this.fi[p] += (u * sim) / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)) / dlon;
      this.fj[p] += (v * sim) / M_PER_DEG / dlat;
      const out = this.fi[p] < 0 || this.fi[p] > nlon - 1.001 || this.fj[p] < 0 || this.fj[p] > nlat - 1.001;
      if (out || this.age[p] > this.life[p] || !this._above(field, p) || !Number.isFinite(u + v)) {
        this._respawn(p, field);
      } else {
        const base = p * T * 3;
        this.hist.copyWithin(base + 3, base, base + (T - 1) * 3);   // shift trail back one slot
        const [lon, la] = this._lonlat(p);
        this.hist[base] = lon; this.hist[base + 1] = la; this.hist[base + 2] = this._h(field, p);
      }
      // Fade in/out over the lifetime; stronger with speed (full from ~25 m/s);
      // fading toward the tail.
      const lifeFrac = this.age[p] / this.life[p];
      const fade = Math.max(0, Math.min(1, lifeFrac * 5, (1 - lifeFrac) * 4));
      const strength = fade * (0.45 + 0.55 * Math.min(1, Math.hypot(u, v) / 25));
      for (let k = 0; k < segs; k++) {
        const s = p * segs + k, h0 = (p * T + k) * 3;
        this.iA[s * 3] = this.hist[h0]; this.iA[s * 3 + 1] = this.hist[h0 + 1]; this.iA[s * 3 + 2] = this.hist[h0 + 2];
        this.iB[s * 3] = this.hist[h0 + 3]; this.iB[s * 3 + 1] = this.hist[h0 + 4]; this.iB[s * 3 + 2] = this.hist[h0 + 5];
        const a0 = strength * (1 - k / segs), a1 = strength * (1 - (k + 1) / segs);
        this.cA[s * 4] = r; this.cA[s * 4 + 1] = g; this.cA[s * 4 + 2] = b; this.cA[s * 4 + 3] = a0;
        this.cB[s * 4] = r; this.cB[s * 4 + 1] = g; this.cB[s * 4 + 2] = b; this.cB[s * 4 + 3] = a1;
      }
    }
    for (const name of ["iA", "iB", "cA", "cB"]) this.geom.attributes[name].needsUpdate = true;
  }
}

// Barb segments for one station, in scene km (x east, y north; Mercator is
// conformal, so compass directions carry over unchanged). u, v in knots;
// L = staff length. Ported from the Radar Volume Explorer project
// (web/sounding.js barbSegments), which drew them in the same frame.
export function barbSegments(x, y, u, v, L) {
  const kt = Math.hypot(u, v), out = [];
  if (kt < 2.5) {                                       // calm: a small circle
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * 2 * Math.PI, b = ((k + 1) / 12) * 2 * Math.PI, r = L * 0.12;
      out.push([x + r * Math.cos(a), y + r * Math.sin(a)], [x + r * Math.cos(b), y + r * Math.sin(b)]);
    }
    return out;
  }
  const s = [-u / kt, -v / kt], side = [s[1], -s[0]];   // toward the source; barbs clockwise
  const tip = [x + s[0] * L, y + s[1] * L];
  out.push([x, y], tip);
  let left = Math.round(kt / 5) * 5, pos = 0;
  const step = L * 0.13, flen = L * 0.4;
  const at = (d) => [tip[0] - s[0] * d, tip[1] - s[1] * d];
  while (left >= 50) {                                   // pennant: a triangle
    const a = at(pos), b = at(pos + step), p = [a[0] + side[0] * flen, a[1] + side[1] * flen];
    out.push(a, p, p, b);
    pos += step * 1.2; left -= 50;
  }
  while (left >= 10) {
    const a = at(pos), p = [a[0] + side[0] * flen + s[0] * step * 0.6, a[1] + side[1] * flen + s[1] * step * 0.6];
    out.push(a, p);
    pos += step; left -= 10;
  }
  if (left >= 5) {
    if (pos === 0) pos = step;                           // a lone half barb sits in from the tip
    const a = at(pos), p = [a[0] + side[0] * flen / 2 + s[0] * step * 0.3, a[1] + side[1] * flen / 2 + s[1] * step * 0.3];
    out.push(a, p);
  }
  return out;
}

export class BarbLayer {
  constructor(grid, geo, { every = 6, length = 190, lift = 8, color = "#111", renderOrder = 21 } = {}) {
    this.grid = grid;
    this.every = every;
    this.length = length;
    this.color = new THREE.Color(color);
    this.material = lineMaterial(lift, geo);
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = renderOrder;
    this.key = null;
  }

  get object() { return this.lines; }

  // u, v in m/s; h in m (or null); o: 0/1 above-ground mask (or null).
  build(key, u, v, h, o) {
    if (key === this.key) return;
    this.key = key;
    const { nlat, nlon, lat0, dlat, lon0, dlon } = this.grid;
    const pos = [], col = [], off = [];
    const { r, g, b } = this.color;
    const KT = 1.943844;
    for (let j = Math.floor(this.every / 2); j < nlat; j += this.every) {
      for (let i = Math.floor(this.every / 2); i < nlon; i += this.every) {
        const k = j * nlon + i;
        if (o && o[k] < 0.5) continue;
        const lat = lat0 + j * dlat, lon = lon0 + i * dlon, z = h ? h[k] : 0;
        for (const [dx, dy] of barbSegments(0, 0, u[k] * KT, v[k] * KT, this.length)) {
          pos.push(lon, lat, z);
          off.push(dx, dy);
          col.push(r, g, b, 0.9);
        }
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geom.setAttribute("rgba", new THREE.Float32BufferAttribute(col, 4));
    geom.setAttribute("offset", new THREE.Float32BufferAttribute(off, 2));
    this.lines.geometry.dispose();
    this.lines.geometry = geom;
  }
}
