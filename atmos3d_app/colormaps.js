// Fill colour scales for the explorer. Each scale is a list of [value, css]
// stops in its display units; `texture()` bakes one into a 256x1 lookup the
// level shader samples, and `cssGradient()` draws the matching legend bar.
import * as THREE from "three";

// ColorBrewer-derived stops (RdYlBu reversed for temperature, BrBG for
// humidity) and a blue-green-yellow-red-purple ramp for wind speed.
const WIND = ["#eef4fa", "#c6dbef", "#9ecae1", "#4292c6", "#41ab5d", "#addd8e", "#fec44f", "#fe9929", "#e31a1c", "#7a0177"];
const TEMP = ["#313695", "#4575b4", "#74add1", "#abd9e9", "#e0f3f8", "#ffffbf", "#fee090", "#fdae61", "#f46d43", "#d73027", "#a50026"];
const RH = ["#8c510a", "#bf812d", "#dfc27d", "#f6e8c3", "#f5f5f5", "#c7eae5", "#80cdc1", "#35978f", "#01665e"];

function spread(colors, min, max) {
  return colors.map((c, i) => [min + (max - min) * (i / (colors.length - 1)), c]);
}

// key -> {label, units, min, max, stops}. Ranges are fixed per quantity and
// level so colours mean the same thing at every forecast step and in both
// models. Temperature ranges follow each level's typical North Pacific span
// (warm-season tropics to cold-season Bering Sea); wind ranges widen with
// height toward the jet stream.
const TEMP_RANGE = { 1000: [-20, 35], 925: [-25, 30], 850: [-30, 25], 700: [-35, 15], 500: [-45, -5], 300: [-60, -30], 250: [-65, -35] };
const WIND_MAX = { 1000: 60, 925: 70, 850: 80, 700: 90, 500: 120, 300: 180, 250: 180 };

export const SCALES = {
  wind10: { label: "10 m wind speed", units: "kt", min: 0, max: 60, stops: spread(WIND, 0, 60) },
  t2m: { label: "2 m temperature", units: "°C", min: -30, max: 35, stops: spread(TEMP, -30, 35) },
};
for (const [lv, [tmin, tmax]] of Object.entries(TEMP_RANGE)) {
  SCALES[`wind${lv}`] = { label: `${lv} mb wind speed`, units: "kt", min: 0, max: WIND_MAX[lv], stops: spread(WIND, 0, WIND_MAX[lv]) };
  SCALES[`t${lv}`] = { label: `${lv} mb temperature`, units: "°C", min: tmin, max: tmax, stops: spread(TEMP, tmin, tmax) };
  SCALES[`rh${lv}`] = { label: `${lv} mb relative humidity`, units: "%", min: 0, max: 100, stops: spread(RH, 0, 100) };
}

const textures = new Map();

export function texture(key) {
  if (!textures.has(key)) {
    const { stops, min, max } = SCALES[key];
    const data = new Uint8Array(256 * 4);
    const rgb = stops.map(([v, c]) => [v, new THREE.Color(c)]);
    for (let i = 0; i < 256; i++) {
      const v = min + (max - min) * (i / 255);
      let k = 0;
      while (k < rgb.length - 2 && v > rgb[k + 1][0]) k++;
      const [v0, c0] = rgb[k], [v1, c1] = rgb[k + 1];
      const f = Math.min(1, Math.max(0, (v - v0) / (v1 - v0)));
      const c = c0.clone().lerp(c1, f);
      data.set([Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), 255], i * 4);
    }
    const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    textures.set(key, tex);
  }
  return textures.get(key);
}

export function cssGradient(key) {
  const { stops, min, max } = SCALES[key];
  const parts = stops.map(([v, c]) => `${c} ${(((v - min) / (max - min)) * 100).toFixed(1)}%`);
  return `linear-gradient(to right, ${parts.join(", ")})`;
}
