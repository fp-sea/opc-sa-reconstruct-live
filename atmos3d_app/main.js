// 3D Atmosphere Explorer (atmos3d): GFS and ECMWF forecast fields at their
// true (exaggerated) height over the site's Mercator basemap -- sea-level
// pressure with 10 m wind / 2 m temperature fills, and pressure levels
// 1000-250 mb with height contours and wind / temperature / humidity fills --
// animated through the 3-hourly steps with smooth blending between them.
//
// Data: <data>/manifest.json + gzipped uint16 bundles written by
// src/assemble/export_atmos3d.py. Scene approach adapted from the sibling
// Radar Volume Explorer project (three.js, OrbitControls, z-up km scene,
// render-on-demand loop); its radar-centred projection is replaced by the
// Mercator in project.js.
import * as THREE from "three";
import { OrbitControls } from "three/addons/OrbitControls.js";
import { R_KM, makeGeo, mercatorKm, selfCheck } from "./project.js";
import { SatelliteFrames } from "./satellite.js";
import { makeGround } from "./ground.js";
import { BundleLoader } from "./loader.js";
import { SCALES, cssGradient } from "./colormaps.js";
import { GridLayer } from "./levelMesh.js";
import { Timeline } from "./timeline.js";
import { BarbLayer, PARTICLE_STYLE, ParticleSystem } from "./winds.js";
import { CoastOverlay } from "./overlays.js";

const root = document.getElementById("atmos3d");
const DATA = root.dataset.data;
const $ = (id) => document.getElementById(id);
let dirty = true;   // set whenever something on screen changed; the loop renders only then (or while playing)
let hover = null;   // hover readout target: {lat, lon} + {px, py} canvas px, or null

const manifest = await (await fetch(`${DATA}/manifest.json`, { cache: "no-cache" })).json();
const KT = 1.943844;
const MODEL_LABEL = { gfs: "GFS", ecmwf: "ECMWF" };
let model = manifest.models[0];

// ---- projection + self-check -------------------------------------------------
// geo: flat Mercator <-> globe, blended by geo.uniforms.morph (project.js).
const geo = makeGeo(manifest.ground);
const projErrKm = selfCheck(manifest.projection.control_points);
console.info(`[atmos3d] projection self-check: max ${projErrKm.toFixed(3)} km vs pyproj`);

// ---- scene ------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
root.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color("#0b0e13");
const camera = new THREE.PerspectiveCamera(45, 1, 5, 150000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.screenSpacePanning = true;

// Ground: the gallery's own basemap, rendered by render_ground_texture.py.
const ground = makeGround(DATA, manifest, geo, () => { dirty = true; });
ground.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
scene.add(ground.mesh);

// Globe backdrop: the rest of the Earth just below the ground, with a
// whole-Earth basemap in the same style (render_world_texture.py), slightly
// dimmed so the forecast domain stands out. Texture coordinates come from
// each pixel's own lat/lon (undoing the globe's rotation), so there is no
// seam at the dateline. Fades in with the morph; hidden on the flat map.
const worldTex = manifest.world ? new THREE.TextureLoader().load(`${DATA}/${manifest.world.file}`, () => { dirty = true; }) : null;
if (worldTex) { worldTex.colorSpace = THREE.NoColorSpace; worldTex.generateMipmaps = false; worldTex.minFilter = THREE.LinearFilter; }
const backdrop = new THREE.Mesh(
  new THREE.SphereGeometry(R_KM - 8, 128, 96),
  new THREE.ShaderMaterial({
    uniforms: { geoRot: geo.uniforms.geoRot, map: { value: worldTex }, hasMap: { value: worldTex ? 1 : 0 }, opacity: { value: 0 } },
    vertexShader: `varying vec3 vDir;
      void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform mat3 geoRot; uniform sampler2D map; uniform float hasMap; uniform float opacity;
      varying vec3 vDir;
      void main() {
        vec3 s = normalize(vDir);
        vec3 e = vec3(dot(geoRot[0], s), dot(geoRot[1], s), dot(geoRot[2], s));   // scene -> Earth-centred
        vec2 uv = vec2(atan(e.y, e.x) / 6.283185307 + 0.5, asin(clamp(e.z, -1.0, 1.0)) / 3.141592654 + 0.5);
        vec3 c = hasMap > 0.5 ? texture2D(map, uv).rgb * 0.8 : vec3(0.11, 0.17, 0.23);
        gl_FragColor = vec4(c, opacity);
      }`,
    transparent: true,
  }),
);
backdrop.position.set(0, 0, -R_KM);
backdrop.renderOrder = -1;
backdrop.visible = false;
scene.add(backdrop);

// ---- layer definitions ----------------------------------------------------------
// Standard constant-pressure-chart height intervals: 30 m low in the
// atmosphere, 60 m at 500 mb, 120 m near the jet.
const HEIGHT_INTERVAL = { 1000: 30, 925: 30, 850: 30, 700: 30, 500: 60, 300: 120, 250: 120 };
const DEFAULT_ON = new Set(["sfc", "p500"]);

function surfaceDef() {
  return {
    key: "sfc",
    title: "Sea-level pressure",
    bundle: "sfc",
    contourLabel: "isobars every 4 hPa",
    interval: 4,
    fills: { none: null, wind10: "wind10", t2m: "t2m" },
    defaultFill: "none",
    opacity: 0.6,
    options: { lift: 12, lineColor: "#26303c", lineWidth: 1.3, renderOrder: 10 },
    derive(f) {
      const n = f.mslp.length;
      const c = new Float32Array(n), wind10 = new Float32Array(n), t2m = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        c[k] = f.mslp[k] / 100;
        wind10[k] = Math.hypot(f.u10[k], f.v10[k]) * KT;
        t2m[k] = f.t2m[k] - 273.15;
      }
      return { h: null, c, o: null, u: f.u10, v: f.v10, fills: { wind10, t2m } };
    },
  };
}

function levelDef(lv, order) {
  return {
    key: `p${lv}`,
    level: lv,
    title: `${lv} mb`,
    bundle: `p${lv}`,
    contourLabel: `heights every ${HEIGHT_INTERVAL[lv] ?? 60} m`,
    interval: HEIGHT_INTERVAL[lv] ?? 60,
    fills: { [`wind${lv}`]: `wind${lv}`, [`t${lv}`]: `t${lv}`, [`rh${lv}`]: `rh${lv}`, none: null },
    defaultFill: `wind${lv}`,
    opacity: 0.75,
    options: { lineColor: "#111", lineWidth: 1.2, renderOrder: 20 + 10 * order },
    // sfc: the same step's surface bundle, for the below-ground mask.
    derive(f, sfc) {
      const n = f.gh.length, pa = lv * 100;
      const wind = new Float32Array(n), temp = new Float32Array(n), o = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        wind[k] = Math.hypot(f.u[k], f.v[k]) * KT;
        temp[k] = f.t[k] - 273.15;
        o[k] = sfc.psfc[k] >= pa ? 1 : 0;
      }
      return { h: f.gh, c: f.gh, o, u: f.u, v: f.v, fills: { [`wind${lv}`]: wind, [`t${lv}`]: temp, [`rh${lv}`]: f.r } };
    },
  };
}

const loader = new BundleLoader(DATA, manifest);
const defs = [surfaceDef(), ...[...manifest.levels].sort((a, b) => b - a).map((lv, i) => levelDef(lv, i))];
const layers = {};
// Wind particles: a colour per level (so several levels can animate at once
// and stay distinguishable -- darker, saturated tones for this light
// basemap) and more of them low down, where the detail is. Style (width,
// density, speed, opacity) is global: one set of controls for all levels.
const PARTICLE_COLORS = {
  sfc: "#1d5fa8", p1000: "#0f7c80", p925: "#1b8a3f", p850: "#5f7f00",
  p700: "#b06000", p500: "#c0182f", p300: "#9b1f8f", p250: "#5b2fb0",
};
const PARTICLE_WEIGHT = { sfc: 1.6, p1000: 1.4, p925: 1.4, p850: 1.2, p700: 1.0, p500: 0.8, p300: 0.8, p250: 0.8 };
const PARTICLE_BASE = 3500, PARTICLE_MAX = 10000;
let particleDensity = 1;
// Coastlines traced on every visible layer (coast.json from the export).
const coastLines = manifest.coast ? await fetch(`${DATA}/${manifest.coast}`).then((r) => r.json()).catch(() => null) : null;
let coastOn = true;
for (const def of defs) {
  const gl = new GridLayer(manifest.grid, geo, def.options);
  const lift = def.options.lift ?? 0;
  // Draw order runs strictly bottom to top -- each layer's fill, then its
  // coast, particles and barbs, then the next level up. The translucent
  // fills don't write depth, so order is what keeps a lower layer's glyphs
  // from showing on top of a higher fill (the camera never goes below).
  const barbs = new BarbLayer(manifest.grid, geo, { lift: lift + 8, renderOrder: gl.mesh.renderOrder + 3 });
  // (No coastlines floating on each level: stacked copies read as clutter.
  // The top visible level gets the map printed on it instead -- see
  // updateMapImprint.)
  const coast = null;
  gl.uniforms.mapTex.value = ground.texture;
  scene.add(gl.mesh, barbs.object);
  layers[def.key] = {
    def, gl, particles: null, barbs, coast, fill: def.defaultFill, derived: new Map(), visible: DEFAULT_ON.has(def.key),
    particlesOn: def.key === "sfc", barbsOn: false, current: null,
  };
  gl.uniforms.cInterval.value = def.interval;
  gl.uniforms.fillOpacity.value = def.opacity;
  gl.setFill(def.fills[def.defaultFill], SCALES[def.fills[def.defaultFill]]);
  gl.visible = false;
}

function leadsFor(m) {
  return manifest.leads_h.filter((h) => loader.has(m, h, "sfc"));
}
let leads = leadsFor(model);

// ---- satellite lead-in ------------------------------------------------------------
// Observed infrared for the ~24 h before T0, draped on the ground (see
// satellite.js). Before T0 only observations show; the model layers appear
// at T0, and the last image fades out over the first 3 forecast hours.
const sat = manifest.satellite?.frames?.length ? new SatelliteFrames(DATA, manifest.satellite, manifest.reference_cycle) : null;
let satOn = !!sat, satEnhance = false;
// The IR image covers the basemap's coastlines, so the ground gets its own
// (light, to read on the dark image) whenever the image shows.
const groundCoast = coastLines ? new CoastOverlay(coastLines, manifest.grid, geo, { lift: 1, color: "#e3b84f", opacity: 0.9, renderOrder: 5 }) : null;
if (groundCoast) {
  groundCoast.setSlot("A", "ground", null);
  groundCoast.setSlot("B", "ground", null);
  groundCoast.object.visible = false;
  scene.add(groundCoast.object);
}
if (sat) sat.loadAll(() => { if (timeline.pos <= 0) updateSatellite(); dirty = true; });

function updateSatellite() {
  const u = ground.uniforms;
  const hit = sat && satOn ? sat.textureAt(Math.min(timeline.pos, 0)) : null;
  if (hit) u.satMap.value = hit.tex;
  u.satMix.value = hit ? (timeline.pos <= 0 ? 1 : Math.max(0, 1 - timeline.pos / 3)) : 0;
  u.satEnhance.value = satEnhance ? 1 : 0;
  if (groundCoast) groundCoast.object.visible = coastOn && u.satMix.value > 0.05;
  const wasShown = !!satShown;
  satShown = u.satMix.value > 0 ? hit : null;
  if (wasShown !== !!satShown && typeof updateLegend === "function") updateLegend();
  dirty = true;
}
let satShown = null;

const timeline = new Timeline(leads, sat ? sat.hours : []);

// Bundles a visible layer needs for one step (levels also need the surface
// bundle for their below-ground mask).
function bundlesFor(L) {
  return L.def.bundle === "sfc" ? ["sfc"] : [L.def.bundle, "sfc"];
}

function derivedFor(L, lead) {
  const key = `${model}:${lead}`;
  if (L.derived.has(key)) return L.derived.get(key);
  const fields = loader.ready(model, lead, L.def.bundle);
  const sfc = loader.ready(model, lead, "sfc");
  if (!fields || !sfc) return null;
  const d = L.def.derive(fields, sfc);
  L.derived.set(key, d);
  return d;
}

function isStepReady(i) {
  const lead = leads[i];
  return Object.values(layers).every((L) => !L.visible || bundlesFor(L).every((b) => loader.ready(model, lead, b)));
}

function slotValues(L, d) {
  return { h: d.h, c: d.c, o: d.o, f: L.fill && L.def.fills[L.fill] ? d.fills[L.fill] : null };
}

// Push the two real steps around the current time into every visible layer.
function applyTime(force = false) {
  const { i0, i1, t } = timeline.segment();
  const observed = timeline.beforeModel;     // no model data this early
  for (const L of Object.values(layers)) {
    L.gl.visible = L.visible && !observed;
    if (observed) L.current = null;
    if (!L.visible || observed) continue;
    const a = derivedFor(L, leads[i0]);
    const bReal = derivedFor(L, leads[i1]);
    const b = bReal ?? a;
    if (!a) { L.gl.visible = false; L.current = null; continue; }
    const keyA = `${model}:${leads[i0]}`, keyB = `${model}:${leads[i1]}`;
    if (force || L.gl.slotLead.A !== keyA) L.gl.setSlot("A", keyA, slotValues(L, a));
    if (force || L.gl.slotLead.B !== keyB) L.gl.setSlot("B", keyB, slotValues(L, b));
    const tt = bReal ? t : 0;
    L.gl.uniforms.t.value = tt;
    L.current = { a, b, t: tt };
    if (L.coast) {
      L.coast.setSlot("A", keyA, a.h);
      L.coast.setSlot("B", keyB, b.h);
      L.coast.uniforms.t.value = tt;
    }
    if (L.barbsOn) {
      // Barbs show the nearer real step, never a blend.
      const nearer = tt < 0.5 ? [keyA, a] : [keyB, b];
      if (force) L.barbs.key = null;
      L.barbs.build(nearer[0], nearer[1].u, nearer[1].v, nearer[1].h, nearer[1].o);
    }
  }
  updateWindVisibility();
  updateMapImprint();
  updateSatellite();
  updateHud();
  if (hover) updateReadout();
  dirty = true;
}

// The basemap printed on the TOP visible level with a fill (the one you look
// at from above; lower ones are seen through it), so land and coastlines stay
// in view without a coastline floating on every level.
function updateMapImprint() {
  const drawn = Object.values(layers).filter((L) => L.gl.visible && L.def.fills[L.fill]);
  const top = drawn.sort((a, b) => b.gl.mesh.renderOrder - a.gl.mesh.renderOrder)[0];
  for (const L of Object.values(layers)) L.gl.uniforms.mapMix.value = coastOn && L === top ? 0.6 : 0;
}

// Particle systems are made the first time a layer's particles are switched
// on (each holds ~6 MB of buffers).
function particlesFor(L) {
  if (!L.particles) {
    L.particles = new ParticleSystem(manifest.grid, geo, {
      count: PARTICLE_MAX, lift: (L.def.options.lift ?? 0) + 6,
      color: PARTICLE_COLORS[L.def.key] ?? "#0d2233", renderOrder: L.gl.mesh.renderOrder + 2,
    });
    L.particles.material.uniforms.vex.value = L.gl.uniforms.vex.value;
    scene.add(L.particles.object);
  }
  return L.particles;
}

function updateWindVisibility() {
  for (const L of Object.values(layers)) {
    const on = L.visible && L.particlesOn && !!L.current;
    if (on) particlesFor(L).setCount(PARTICLE_BASE * particleDensity * (PARTICLE_WEIGHT[L.def.key] ?? 1));
    if (L.particles) L.particles.object.visible = on;
    L.barbs.object.visible = L.visible && L.barbsOn && !!L.current;
    if (L.coast) L.coast.object.visible = L.visible && coastOn && !!L.current;
  }
  updateParticleKey();
}

function updateParticleKey() {
  const key = $("particleKey");
  if (!key) return;
  const on = Object.values(layers).filter((L) => L.visible && L.particlesOn);
  key.innerHTML = on.map((L) => `<span class="pkey"><i style="background:${PARTICLE_COLORS[L.def.key]}"></i>${L.def.key === "sfc" ? "10 m" : L.def.title}</span>`).join("");
}

// Load the neighbours of the current time first, then everything else in order.
function requestAround() {
  const { i0, i1 } = timeline.segment();
  const m = model;
  for (const i of [i0, i1, ...leads.keys()]) {
    for (const L of Object.values(layers)) {
      if (!L.visible) continue;
      for (const b of bundlesFor(L)) {
        loader.load(m, leads[i], b).then(() => {
          if (m !== model) return;
          const s = timeline.segment();
          if (i === s.i0 || i === s.i1) applyTime();
          updateLoadStatus();
        }).catch((e) => console.warn("[atmos3d]", e));
      }
    }
  }
}

// ---- HUD ----------------------------------------------------------------------
const fmtTime = (ms) => new Date(ms).toLocaleString("en-US", {
  timeZone: "UTC", weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
}) + " UTC";
// "18Z run +3h" for a lead-in step (an earlier run), "+12h" for this run.
function sourceText(lead) {
  const src = manifest.sources?.[model]?.[String(lead)];
  if (!src || src.cycle === manifest.reference_cycle) return `${lead >= 0 ? "+" : ""}${lead}h`;
  return `analysis: ${src.cycle.slice(11, 13)}Z run +${src.lead_h}h`;
}

function updateHud() {
  const h = timeline.pos, runTxt = manifest.reference_cycle.slice(0, 13).replace("T", " ") + "Z";
  const badge = $("hudInterp");
  const shown = satShown?.frame;
  const validMs = h < 0 && shown ? Date.parse(shown.time) : Date.parse(manifest.reference_cycle) + h * 3600e3;
  $("hudValid").textContent = fmtTime(validMs);
  if (h < 0) {
    const mins = Math.round(-h * 60);
    $("hudLead").textContent = `T−${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
  } else {
    $("hudLead").textContent = `+${h.toFixed(h % 1 ? 1 : 0)}h`;
  }
  const notes = [];
  if (timeline.beforeModel) {
    $("hudRun").textContent = `before the ${runTxt} run`;
    notes.push(shown ? "observed: satellite infrared" : "no model data this early");
  } else {
    const { i0, i1, t } = timeline.segment();
    const near = leads[t < 0.5 ? i0 : i1];
    const leadIn = h < 0;
    $("hudRun").textContent = leadIn
      ? `${MODEL_LABEL[model] ?? model} ${sourceText(near)} · lead-in to the ${runTxt} run`
      : `${MODEL_LABEL[model] ?? model} run ${runTxt}`;
    if (timeline.isInterpolated()) notes.push(`interpolated between ${sourceText(leads[i0])} and ${sourceText(leads[i1])}`);
    if (leadIn && shown) notes.push("with observed satellite infrared");
  }
  badge.hidden = !notes.length;
  badge.textContent = notes.join(" · ");
  $("timeSlider").value = String(h);
}
function updateLoadStatus() {
  let total = 0, have = 0;
  for (const L of Object.values(layers)) {
    if (!L.visible) continue;
    for (const h of leads) {
      total++;
      if (bundlesFor(L).every((b) => loader.ready(model, h, b))) have++;
    }
  }
  $("loadStatus").textContent = have < total ? `loading ${have}/${total} layer-steps…` : `${(loader.bytes / 1e6).toFixed(1)} MB loaded`;
}

// ---- time controls ------------------------------------------------------------
const slider = $("timeSlider");
slider.min = String(timeline.start);
slider.max = String(timeline.end);
slider.addEventListener("input", () => { timeline.pos = Number(slider.value); requestAround(); applyTime(); });
slider.addEventListener("change", () => { timeline.snap(); applyTime(); });

function setPlaying(on) {
  timeline.playing = on;
  $("playBtn").textContent = on ? "❚❚ Pause" : "▶ Play";
  if (!on) { timeline.snap(); applyTime(); }
}
const stepBy = (d) => { setPlaying(false); timeline.step(d); requestAround(); applyTime(); };
$("playBtn").addEventListener("click", () => setPlaying(!timeline.playing));
$("prevBtn").addEventListener("click", () => stepBy(-1));
$("nextBtn").addEventListener("click", () => stepBy(1));
$("speedSel").addEventListener("change", (e) => { timeline.stepsPerSecond = Number(e.target.value); });
window.addEventListener("keydown", (e) => {
  if (e.target.closest("input, select")) return;
  if (e.code === "Space") { e.preventDefault(); setPlaying(!timeline.playing); }
  if (e.code === "ArrowRight") stepBy(1);
  if (e.code === "ArrowLeft") stepBy(-1);
});

// ---- model toggle -----------------------------------------------------------------
const modelBox = $("modelToggle");
modelBox.innerHTML = manifest.models.map((m) =>
  `<label><input type="radio" name="model" value="${m}"${m === model ? " checked" : ""}> ${MODEL_LABEL[m] ?? m}</label>`).join("");
modelBox.addEventListener("change", (e) => {
  model = e.target.value;
  leads = leadsFor(model);
  timeline.setTimes(leads);      // position is in hours, so it carries over
  slider.max = String(timeline.end);
  requestAround();
  applyTime(true);
  updateLoadStatus();
});

// ---- view controls ----------------------------------------------------------------
// Vertical exaggeration on a log slider, 1x .. 400x.
const vexSlider = $("vexSlider");
function setVex(v) {
  for (const L of Object.values(layers)) {
    L.gl.uniforms.vex.value = v;
    if (L.particles) L.particles.material.uniforms.vex.value = v;
    if (L.coast) L.coast.uniforms.vex.value = v;
    L.barbs.material.uniforms.vex.value = v;
  }
  $("vexValue").textContent = `×${Math.round(v)}`;
  if (hover) updateReadout();
  dirty = true;
}
vexSlider.addEventListener("input", () => setVex(Math.pow(10, Number(vexSlider.value))));
setVex(Math.pow(10, Number(vexSlider.value)));

$("coastToggle").addEventListener("change", (e) => { coastOn = e.target.checked; updateMapImprint(); updateSatellite(); });

// Satellite lead-in toggles (disabled when this build has no frames).
if (!sat) { $("satToggle").checked = false; for (const id of ["satToggle", "satEnhance", "satOpacity"]) $(id).disabled = true; }
$("satToggle").addEventListener("change", (e) => { satOn = e.target.checked; updateSatellite(); updateHud(); updateLegend(); });
$("satOpacity").addEventListener("input", (e) => { ground.uniforms.satOpacity.value = Number(e.target.value); dirty = true; });
$("satEnhance").addEventListener("change", (e) => { satEnhance = e.target.checked; updateSatellite(); updateLegend(); });

// Global barb style: spacing (grid points between barbs, 0.5 deg each) and size.
const BARB_STYLE = { every: 6, length: 190 };
function applyBarbStyle() {
  for (const L of Object.values(layers)) { L.barbs.every = BARB_STYLE.every; L.barbs.length = BARB_STYLE.length; L.barbs.key = null; }
  applyTime(true);
}
$("barbSpacing").addEventListener("change", (e) => { BARB_STYLE.every = Number(e.target.value); applyBarbStyle(); });
$("barbSize").addEventListener("input", (e) => { BARB_STYLE.length = Number(e.target.value); applyBarbStyle(); });

// Global particle style.
$("pWidth").addEventListener("input", (e) => { PARTICLE_STYLE.width.value = Number(e.target.value); dirty = true; });
$("pOpacity").addEventListener("input", (e) => { PARTICLE_STYLE.opacity.value = Number(e.target.value); dirty = true; });
$("pSpeed").addEventListener("input", (e) => { PARTICLE_STYLE.speed = Number(e.target.value); });
$("pDensity").addEventListener("input", (e) => { particleDensity = Math.pow(10, Number(e.target.value)); updateWindVisibility(); });

// ---- layer panel + legend ------------------------------------------------------------
const legend = $("legend");
function updateLegend() {
  legend.innerHTML = "";
  if (satShown) {
    const e = manifest.satellite;
    const row = document.createElement("div");
    row.className = "legend-row";
    const lo = Math.round(e.vmax_k - 273.15), hi = Math.round(e.vmin_k - 273.15);
    // Enhanced: grey to -30 C, then 10 C colour bands (same as ground.js).
    const pct = (c) => (((lo - c) / (lo - hi)) * 100).toFixed(1);
    const bands = [[-30, "#80b3ff"], [-40, "#2e70db"], [-50, "#2eb34a"], [-60, "#f2d13b"], [-70, "#e03a2e"], [-80, "#c25cd6"]];
    const grad = satEnhance
      ? `linear-gradient(to right,#000 0%,#b0b0b0 ${pct(-30)}%,${bands.map(([c, col], i) => `${col} ${pct(c)}%,${col} ${pct(bands[i + 1]?.[0] ?? hi)}%`).join(",")})`
      : "linear-gradient(to right,#000,#fff)";
    row.innerHTML = `<span class="legend-label">Satellite infrared (°C; ${satEnhance ? "colours = cold, high cloud tops" : "white = cold, high cloud"})</span>
      <span class="legend-bar" style="background:${grad}"></span>
      <span class="legend-ends"><span>${lo}</span><span>${hi}</span></span>`;
    legend.appendChild(row);
  }
  for (const L of Object.values(layers)) {
    const key = L.visible && L.def.fills[L.fill];
    if (!key) continue;
    const s = SCALES[key];
    const row = document.createElement("div");
    row.className = "legend-row";
    row.innerHTML = `<span class="legend-label">${s.label} (${s.units})</span>
      <span class="legend-bar" style="background:${cssGradient(key)}"></span>
      <span class="legend-ends"><span>${s.min}</span><span>${s.max}</span></span>`;
    legend.appendChild(row);
  }
}
const panel = $("layerPanel");
for (const L of Object.values(layers)) {
  const box = document.createElement("fieldset");
  box.className = "layer";
  box.dataset.on = L.visible ? "1" : "0";
  const fillOpts = Object.keys(L.def.fills).map((k) =>
    `<option value="${k}"${k === L.fill ? " selected" : ""}>${k === "none" ? "no fill" : SCALES[L.def.fills[k]].label}</option>`).join("");
  box.innerHTML = `<legend><label><input type="checkbox" data-k="vis"${L.visible ? " checked" : ""}> ${L.def.title}</label></legend>
    <div class="layer-body">
      <label><input type="checkbox" data-k="lines" checked> ${L.def.contourLabel}</label>
      <label><input type="checkbox" data-k="particles"${L.particlesOn ? " checked" : ""}> wind particles</label>
      <label><input type="checkbox" data-k="barbs"${L.barbsOn ? " checked" : ""}> wind barbs</label>
      <label>Fill <select data-k="fill">${fillOpts}</select></label>
      <label>Opacity <input type="range" data-k="op" min="0.1" max="1" step="0.05" value="${L.def.opacity}"></label>
    </div>`;
  box.addEventListener("input", (e) => {
    const k = e.target.dataset.k;
    if (k === "vis") { L.visible = e.target.checked; box.dataset.on = L.visible ? "1" : "0"; requestAround(); }
    if (k === "lines") L.gl.uniforms.showLines.value = e.target.checked;
    if (k === "particles") L.particlesOn = e.target.checked;
    if (k === "barbs") { L.barbsOn = e.target.checked; L.barbs.key = null; }
    if (k === "op") L.gl.uniforms.fillOpacity.value = Number(e.target.value);
    if (k === "fill") {
      L.fill = e.target.value;
      const sk = L.def.fills[L.fill];
      L.gl.setFill(sk, SCALES[sk]);
    }
    applyTime(true);
    updateLegend();
    updateLoadStatus();
  });
  panel.appendChild(box);
}
updateLegend();

// ---- cameras ------------------------------------------------------------------------
// The top view is a telephoto (narrow field of view, far away) so it reads
// like a flat chart: at 45 degrees a lifted level would look several percent
// larger than the ground beneath it from simple perspective; at 8 degrees
// from far enough away to fit the domain, that parallax drops to ~1%.
// Presets are built for the current window shape: on a narrow window the
// camera backs off (same viewing direction) until the whole domain width fits.
function camPreset(name) {
  const W = geo.width, H = geo.height, a = camera.aspect || 1.6;
  if (name === "top") {
    const fov = 8, t = Math.tan((fov / 2) * Math.PI / 180);
    const d = Math.max(H * 1.12, (W * 1.06) / a) / (2 * t);
    return { pos: [0, -1, d], target: [0, 0, 0], fov };
  }
  const widen = Math.max(1, 2.0 / a);
  if (name === "globe") return { pos: [0, -H * 1.55 * widen, H * 0.95 * widen], target: [0, 250, -900], fov: 45 };
  if (name === "low") return { pos: [-W * 0.2 * widen, -H * 0.72 * widen, 900 * widen], target: [0, 200, 500], fov: 45 };
  return { pos: [0, -H * 1.35 * widen, H * 0.75 * widen], target: [0, 0, 250], fov: 45 };
}
let flight = null;
function flyTo(name, instant = false) {
  const c = camPreset(name);
  const to = { pos: new THREE.Vector3(...c.pos), target: new THREE.Vector3(...c.target), fov: c.fov };
  if (instant) {
    camera.position.copy(to.pos); controls.target.copy(to.target);
    camera.fov = to.fov; camera.updateProjectionMatrix(); controls.update(); dirty = true; return;
  }
  flight = { from: { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov }, to, t0: performance.now(), ms: 1400 };
}
for (const b of document.querySelectorAll("[data-cam]")) b.addEventListener("click", () => flyTo(b.dataset.cam));

// Flat map <-> globe: animate the shared morph uniform (0 flat, 1 globe).
let morphAnim = null;
$("shapeToggle").addEventListener("change", (e) => {
  const to = e.target.value === "globe" ? 1 : 0;
  morphAnim = { from: geo.uniforms.morph.value, to, t0: performance.now(), ms: 1600 };
  flyTo(to ? "globe" : "oblique");
});

// ---- hover readout --------------------------------------------------------------
// Values at the ground point under the cursor, for every visible layer, at
// the nearer REAL model step (never a blended value). A vertical pin marks
// the column: in an oblique view a lifted level under the cursor is a
// different spot than the ground under it, so the pin shows which column
// the numbers belong to. The top (chart) view is exact.
const tip = $("readout");
const raycaster = new THREE.Raycaster();
const pin = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0xd99b3f, depthTest: false, transparent: true }),
);
pin.renderOrder = 999;
pin.visible = false;
scene.add(pin);

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
function windText(u, v) {
  const kt = Math.hypot(u, v) * KT;
  if (kt < 1) return "calm";
  const from = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
  return `${COMPASS[Math.round(from / 22.5) % 16]} ${Math.round(kt)} kt`;
}

function updateReadout() {
  if (!hover) { tip.hidden = true; pin.visible = false; return; }
  const g = manifest.grid;
  const { lat, lon } = hover;
  const fi = (lon - g.lon0) / g.dlon, fj = (lat - g.lat0) / g.dlat;
  if (fi < 0 || fj < 0 || fi > g.nlon - 1 || fj > g.nlat - 1) { tip.hidden = true; pin.visible = false; return; }
  const k = Math.round(fj) * g.nlon + Math.round(fi);
  const { i0, i1, t } = timeline.segment();
  const lead = leads[t < 0.5 ? i0 : i1];
  const observed = timeline.beforeModel;
  const lonTxt = lon > 180 ? `${(360 - lon).toFixed(1)}°W` : `${lon.toFixed(1)}°E`;
  const when = observed ? "observed" : `${MODEL_LABEL[model] ?? model} ${sourceText(lead)}`;
  const rows = [`<b>${lat.toFixed(1)}°N ${lonTxt}</b> <span class="muted">${when}</span>`];
  if (satShown) {
    const b = manifest.ground, [mx, my] = mercatorKm(lat, lon);
    const kelvin = sat.valueAt(satShown.i, (mx - b.x_west) / (b.x_east - b.x_west), (my - b.y_south) / (b.y_north - b.y_south));
    const at = satShown.frame.time.slice(11, 16);
    rows.push(kelvin == null ? `Satellite IR ${at} UTC: no data`
      : `Satellite IR ${at} UTC: ${(kelvin - 273.15).toFixed(0)}°C <span class="muted">(${kelvin < 253 ? "cloud top" : "cloud top or surface"})</span>`);
  }
  let top = 0;
  for (const L of Object.values(layers)) {
    if (!L.visible || observed) continue;
    const d = derivedFor(L, lead);
    if (!d) continue;
    if (L.def.key === "sfc") {
      rows.push(`Sea level: ${d.c[k].toFixed(1)} hPa · 10 m ${windText(d.u[k], d.v[k])} · 2 m ${d.fills.t2m[k].toFixed(1)}°C`);
    } else if (d.o[k] < 0.5) {
      rows.push(`${L.def.title}: below ground here`);
    } else {
      const lv = L.def.level;
      top = Math.max(top, d.h[k]);
      rows.push(`${L.def.title}: ${Math.round(d.h[k] / 10)} dam · ${d.fills[`t${lv}`][k].toFixed(1)}°C · ${windText(d.u[k], d.v[k])} · RH ${Math.round(d.fills[`rh${lv}`][k])}%`);
    }
  }
  tip.innerHTML = rows.join("<br>");
  tip.hidden = false;
  const W = root.clientWidth, H = root.clientHeight;
  tip.style.left = `${Math.min(hover.px + 14, W - tip.offsetWidth - 8)}px`;
  tip.style.top = `${Math.min(hover.py + 14, H - tip.offsetHeight - 8)}px`;
  const vex = Math.pow(10, Number($("vexSlider").value));
  const pos = pin.geometry.attributes.position;
  const p0 = geo.point(lat, lon, 0), p1 = geo.point(lat, lon, Math.max(top * 0.001 * vex, 40) + 30);
  pos.setXYZ(0, p0.x, p0.y, p0.z);
  pos.setXYZ(1, p1.x, p1.y, p1.z);
  pos.needsUpdate = true;
  pin.visible = true;
}

renderer.domElement.addEventListener("pointermove", (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = geo.pick(raycaster.ray);
  hover = hit ? { lat: hit.latlon[0], lon: hit.latlon[1], px: e.clientX - r.left, py: e.clientY - r.top } : null;
  updateReadout();
  dirty = true;
});
renderer.domElement.addEventListener("pointerleave", () => { hover = null; updateReadout(); dirty = true; });

// ---- render loop --------------------------------------------------------------
controls.addEventListener("change", () => { dirty = true; });
function resize() {
  const w = root.clientWidth, h = root.clientHeight;
  renderer.setSize(w, h);
  PARTICLE_STYLE.resolution.value.set(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  dirty = true;
}
new ResizeObserver(resize).observe(root);

let last = performance.now();
const fps = { frames: 0, t0: performance.now(), value: 0 };
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (flight) {
    const k = Math.min(1, (now - flight.t0) / flight.ms);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    camera.position.lerpVectors(flight.from.pos, flight.to.pos, e);
    controls.target.lerpVectors(flight.from.target, flight.to.target, e);
    camera.fov = flight.from.fov + (flight.to.fov - flight.from.fov) * e;
    camera.updateProjectionMatrix();
    if (k >= 1) flight = null;
    dirty = true;
  }
  if (morphAnim) {
    const k = Math.min(1, (now - morphAnim.t0) / morphAnim.ms);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    geo.uniforms.morph.value = morphAnim.from + (morphAnim.to - morphAnim.from) * e;
    backdrop.visible = geo.uniforms.morph.value > 0.02;
    backdrop.material.uniforms.opacity.value = geo.uniforms.morph.value;
    if (k >= 1) morphAnim = null;
    if (hover) updateReadout();
    dirty = true;
  }
  if (timeline.tick(dt, isStepReady)) applyTime();
  if (controls.update()) dirty = true;
  for (const L of Object.values(layers)) {
    if (!L.particles || !L.particles.object.visible || !L.current) continue;
    const { a, b, t } = L.current;
    L.particles.update(dt, { uA: a.u, vA: a.v, uB: b.u, vB: b.v, hA: a.h, hB: b.h, oA: a.o, oB: b.o, t });
    dirty = true;
  }
  if (!dirty && !timeline.playing) return;
  const dist = camera.position.distanceTo(controls.target);
  const near = Math.max(1, dist / 2000);
  camera.far = Math.max(60000, dist * 3);
  if (Math.abs(camera.near - near) / near > 0.2) { camera.near = near; camera.updateProjectionMatrix(); }
  renderer.render(scene, camera);
  dirty = false;
  fps.frames++;
  if (now - fps.t0 > 1000) { fps.value = (fps.frames * 1000) / (now - fps.t0); fps.frames = 0; fps.t0 = now; }
}

resize();
flyTo("oblique", true);
requestAround();
applyTime();
updateLoadStatus();
if (manifest.missing.length) $("missingNote").textContent = `${manifest.missing.length} forecast step(s) unavailable this build — the timeline skips them.`;
requestAnimationFrame(frame);

// Debug/verification handle (read-only use).
window.__atmos3d = { manifest, geo, ground, sat, loader, timeline, layers, renderer, camera, controls, projErrKm, fps, get leads() { return leads; }, get model() { return model; }, setPlaying };
