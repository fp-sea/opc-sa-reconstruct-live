// One gridded layer of the explorer (a pressure level, or the sea-level
// surface) as a single mesh over the export grid. Everything that changes
// with time lives in paired vertex attributes for the two real forecast
// steps either side of the current time (A and B); the shader blends them
// with one uniform `t`, so animating between steps uploads nothing.
//
//   h: height (m)   -> z = h/1000 * vex + lift   (true height, exaggerated)
//   f: fill value    -> colour from a 256x1 lookup over [fMin, fMax]
//   c: contour value -> lines every cInterval, drawn per pixel with fwidth
//   o: 1 where the level is above ground, 0 where it lies below the surface
//      (level pressure > surface pressure); those pixels are not drawn
//
// Contours are computed in the fragment shader rather than traced as line
// geometry, so they follow the blended field smoothly during playback.
// Vertices store raw (lon, lat); GEO_GLSL projects them onto the flat map,
// the globe, or anywhere between (project.js).
//
// Map imprint: the basemap can be multiplied into this layer's colour
// (mapMix), so land shading and coastlines show ON the level -- used on the
// top visible level only, since the fills hide the ground's own map.
import * as THREE from "three";
import { texture } from "./colormaps.js";
import { GEO_GLSL, mercatorKm } from "./project.js";

const VERT = /* glsl */ `
${GEO_GLSL}
attribute float hA; attribute float hB;
attribute float fA; attribute float fB;
attribute float cA; attribute float cB;
attribute float oA; attribute float oB;
attribute vec2 muv;
uniform float t; uniform float vex; uniform float lift;
varying vec2 vMuv;
varying float vF; varying float vC; varying float vO;
void main() {
  vO = mix(oA, oB, t);
  vMuv = muv;
  float h = mix(hA, hB, t);
  vF = mix(fA, fB, t);
  vC = mix(cA, cB, t);
  vec3 p = geoPosition(position.y, position.x, h * 0.001 * vex + lift, vec2(0.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D cmap;
uniform float fMin; uniform float fMax; uniform float fillOpacity; uniform bool showFill;
uniform float cInterval; uniform vec3 lineColor; uniform float lineOpacity; uniform bool showLines;
uniform float lineWidth;
uniform sampler2D mapTex; uniform float mapMix;
varying float vF; varying float vC; varying float vO;
varying vec2 vMuv;
void main() {
  if (vO < 0.5) discard;
  vec4 col = vec4(0.0);
  if (showFill) {
    float u = clamp((vF - fMin) / (fMax - fMin), 0.0, 1.0);
    col = vec4(texture2D(cmap, vec2(u, 0.5)).rgb, fillOpacity);
  }
  if (showLines) {
    float v = vC / cInterval;
    float d = abs(fract(v - 0.5) - 0.5) / max(fwidth(v), 1e-6);   // distance to nearest line, px
    float a = (1.0 - clamp(d - 0.5 * lineWidth + 0.5, 0.0, 1.0)) * lineOpacity;
    col.rgb = mix(col.rgb, lineColor, a);
    col.a = max(col.a, a);
  }
  if (col.a < 0.01) discard;
  if (mapMix > 0.0) col.rgb *= mix(vec3(1.0), texture2D(mapTex, vMuv).rgb, mapMix);
  gl_FragColor = col;
}`;

export class GridLayer {
  // grid: manifest.grid; geo: makeGeo() from project.js (shared uniforms)
  constructor(grid, geo, { lift = 0, lineColor = "#222", lineWidth = 1.2, renderOrder = 1 } = {}) {
    const { nlat, nlon, lat0, dlat, lon0, dlon } = grid;
    const n = nlat * nlon;
    this.n = n;
    const pos = new Float32Array(n * 3), muv = new Float32Array(n * 2);
    const b = geo.bounds;
    for (let j = 0; j < nlat; j++) {
      for (let i = 0; i < nlon; i++) {
        const lat = lat0 + j * dlat, lon = lon0 + i * dlon, k = j * nlon + i;
        pos.set([lon, lat, 0], k * 3);
        const [mx, my] = mercatorKm(lat, lon);
        muv.set([(mx - b.x_west) / (b.x_east - b.x_west), (my - b.y_south) / (b.y_north - b.y_south)], k * 2);
      }
    }
    const index = [];
    for (let j = 0; j < nlat - 1; j++) {
      for (let i = 0; i < nlon - 1; i++) {
        const a = j * nlon + i, b = a + 1, c = a + nlon, d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("muv", new THREE.BufferAttribute(muv, 2));
    for (const name of ["hA", "hB", "fA", "fB", "cA", "cB", "oA", "oB"]) {
      const attr = new THREE.BufferAttribute(new Float32Array(n), 1);
      attr.setUsage(THREE.DynamicDrawUsage);
      geom.setAttribute(name, attr);
    }
    geom.setIndex(index);
    this.uniforms = {
      ...geo.uniforms,
      t: { value: 0 }, vex: { value: 120 }, lift: { value: lift },
      cmap: { value: null }, fMin: { value: 0 }, fMax: { value: 1 },
      fillOpacity: { value: 0.8 }, showFill: { value: false },
      cInterval: { value: 1 }, lineColor: { value: new THREE.Color(lineColor) },
      lineOpacity: { value: 0.9 }, showLines: { value: true }, lineWidth: { value: lineWidth },
      mapTex: { value: null }, mapMix: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.frustumCulled = false;   // vertices move in the shader
    this.mesh.renderOrder = renderOrder;
    this.geom = geom;
    this.slotLead = { A: null, B: null };
  }

  // values: {h?, f?, c?, o?: Float32Array}; slot: "A" | "B". A missing o
  // means "everywhere above ground".
  setSlot(slot, lead, values) {
    for (const key of ["h", "f", "c", "o"]) {
      const attr = this.geom.getAttribute(key + slot);
      if (values[key]) attr.array.set(values[key]);
      else attr.array.fill(key === "o" ? 1 : 0);
      attr.needsUpdate = true;
    }
    this.slotLead[slot] = lead;
  }

  setFill(scaleKey, scale) {
    if (!scaleKey) { this.uniforms.showFill.value = false; return; }
    this.uniforms.showFill.value = true;
    this.uniforms.cmap.value = texture(scaleKey);
    this.uniforms.fMin.value = scale.min;
    this.uniforms.fMax.value = scale.max;
  }

  set visible(v) { this.mesh.visible = v; }
  get visible() { return this.mesh.visible; }
}
