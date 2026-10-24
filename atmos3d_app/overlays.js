// Coastlines traced on a layer, at the layer's own height. Opaque level
// fills hide the ground's basemap; drawing the coast on each visible level
// keeps the geography in view -- and at the level's height, not the
// ground's, so it lines up with the fill in an oblique view.
//
// Heights come from the same two real steps as the level mesh (A/B,
// blended by t), sampled bilinearly at each coast vertex when a step
// changes; the shader applies exaggeration and the flat/globe projection.
import * as THREE from "three";
import { GEO_GLSL } from "./project.js";

const VERT = /* glsl */ `
${GEO_GLSL}
attribute float hA; attribute float hB;
uniform float t; uniform float vex; uniform float lift;
void main() {
  vec3 p = geoPosition(position.y, position.x, mix(hA, hB, t) * 0.001 * vex + lift, vec2(0.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FRAG = /* glsl */ `
uniform vec3 color; uniform float opacity;
void main() { gl_FragColor = vec4(color, opacity); }`;

export class CoastOverlay {
  // polylines: [[[lon, lat], ...], ...] (coast.json); grid: manifest.grid
  constructor(polylines, grid, geo, { lift = 3, color = "#1a1f26", opacity = 0.85, renderOrder = 25 } = {}) {
    const pos = [];
    for (const line of polylines) {
      for (let k = 0; k < line.length - 1; k++) pos.push(line[k][0], line[k][1], 0, line[k + 1][0], line[k + 1][1], 0);
    }
    const n = pos.length / 3;
    // Bilinear sample of the grid at each vertex: 4 indices + 4 weights.
    const { nlat, nlon, lat0, dlat, lon0, dlon } = grid;
    this.idx = new Int32Array(n * 4);
    this.w = new Float32Array(n * 4);
    for (let v = 0; v < n; v++) {
      const fi = Math.min(nlon - 1.0001, Math.max(0, (pos[v * 3] - lon0) / dlon));
      const fj = Math.min(nlat - 1.0001, Math.max(0, (pos[v * 3 + 1] - lat0) / dlat));
      const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j, k = j * nlon + i;
      this.idx.set([k, k + 1, k + nlon, k + nlon + 1], v * 4);
      this.w.set([(1 - a) * (1 - b), a * (1 - b), (1 - a) * b, a * b], v * 4);
    }
    this.n = n;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    for (const name of ["hA", "hB"]) geom.setAttribute(name, new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    this.uniforms = {
      ...geo.uniforms, t: { value: 0 }, vex: { value: 120 }, lift: { value: lift },
      color: { value: new THREE.Color(color) }, opacity: { value: opacity },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, transparent: true, depthWrite: false,
    });
    this.lines = new THREE.LineSegments(geom, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = renderOrder;
    this.geom = geom;
    this.slotKey = { A: null, B: null };
  }

  get object() { return this.lines; }

  // h: the layer's height field (m) for one step, or null for "at the layer's
  // lift only" (the sea-level layer).
  setSlot(slot, key, h) {
    if (this.slotKey[slot] === key) return;
    this.slotKey[slot] = key;
    const out = this.geom.getAttribute("h" + slot).array;
    if (!h) out.fill(0);
    else {
      for (let v = 0; v < this.n; v++) {
        let s = 0;
        for (let q = 0; q < 4; q++) s += h[this.idx[v * 4 + q]] * this.w[v * 4 + q];
        out[v] = s;
      }
    }
    this.geom.getAttribute("h" + slot).needsUpdate = true;
  }
}
