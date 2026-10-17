// The explorer's ground: the site's own basemap (render_ground_texture.py)
// on a 0.25-degree lat/lon mesh that the shared projection (project.js
// GEO_GLSL) lays flat or wraps onto the globe. Texture coordinates are the
// Mercator fractions of each vertex, since the texture itself is Mercator;
// at 0.25 deg the texture's own pixels stay put when the mesh bends.
//
// A second texture, the satellite frame on screen (same Mercator pixel grid,
// see copy_satellite_frames.py), blends over the basemap by `satMix`: plain
// greyscale infrared, or colour-enhanced -- the usual forecaster display:
// grey down to -30 C, then a colour band every 10 C (light blue, blue,
// green, yellow, red, magenta below -80 C), so the coldest, highest storm
// tops stand out.
import * as THREE from "three";
import { GEO_GLSL, mercatorKm } from "./project.js";

const VERT = /* glsl */ `
${GEO_GLSL}
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(geoPosition(position.y, position.x, 0.0, vec2(0.0)), 1.0);
}`;

// The texture is sampled without colour-space conversion so it shows
// exactly the PNG's colours, like the level fills' lookup textures.
const FRAG = /* glsl */ `
uniform sampler2D map;
uniform sampler2D satMap;
uniform float satMix;
uniform float satOpacity;   // user's transparency control
uniform float satEnhance;
uniform float satVmin; uniform float satVmax;   // K at white / black
varying vec2 vUv;
void main() {
  vec3 base = texture2D(map, vUv).rgb;
  float g = texture2D(satMap, vUv).r;
  vec3 sat = vec3(g);
  if (satEnhance > 0.5 && g > 0.0) {
    float c = satVmax - g * (satVmax - satVmin) - 273.15;   // brightness temperature, C
    if (c < -80.0) sat = vec3(0.76, 0.36, 0.84);
    else if (c < -70.0) sat = vec3(0.88, 0.23, 0.18);
    else if (c < -60.0) sat = vec3(0.95, 0.82, 0.23);
    else if (c < -50.0) sat = vec3(0.18, 0.70, 0.29);
    else if (c < -40.0) sat = vec3(0.18, 0.44, 0.86);
    else if (c < -30.0) sat = vec3(0.50, 0.70, 1.0);
  }
  gl_FragColor = vec4(mix(base, sat, satMix * satOpacity), 1.0);
}`;

function blackTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

// ground: manifest.ground (file, Mercator bounds); domain box from manifest.grid.
export function makeGround(dataBase, manifest, geo, onLoad, stepDeg = 0.25) {
  const g = manifest.grid, b = manifest.ground;
  const latN = g.lat0, latS = g.lat0 + g.dlat * (g.nlat - 1);
  const lonW = g.lon0, lonE = g.lon0 + g.dlon * (g.nlon - 1);
  const nj = Math.round((latN - latS) / stepDeg) + 1, ni = Math.round((lonE - lonW) / stepDeg) + 1;
  const pos = new Float32Array(ni * nj * 3), uv = new Float32Array(ni * nj * 2);
  for (let j = 0; j < nj; j++) {
    const lat = latN - j * stepDeg;
    for (let i = 0; i < ni; i++) {
      const lon = lonW + i * stepDeg, k = j * ni + i;
      const [mx, my] = mercatorKm(lat, lon);
      pos.set([lon, lat, 0], k * 3);
      uv.set([(mx - b.x_west) / (b.x_east - b.x_west), (my - b.y_south) / (b.y_north - b.y_south)], k * 2);
    }
  }
  const index = [];
  for (let j = 0; j < nj - 1; j++) {
    for (let i = 0; i < ni - 1; i++) {
      const a = j * ni + i, c = a + ni;
      index.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geom.setIndex(index);
  const tex = new THREE.TextureLoader().load(`${dataBase}/${b.file}`, onLoad);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: {
      ...geo.uniforms, map: { value: tex },
      satMap: { value: blackTexture() },
      satMix: { value: 0 }, satOpacity: { value: 1 }, satEnhance: { value: 0 },
      satVmin: { value: manifest.satellite?.vmin_k ?? 190 }, satVmax: { value: manifest.satellite?.vmax_k ?? 300 },
    },
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;
  return { mesh, texture: tex, uniforms: mat.uniforms };
}
