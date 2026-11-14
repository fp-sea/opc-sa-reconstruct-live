// assets/compare.js -- the project's first client-side JS. Drives
// templates/compare.html.j2 entirely off site/compare_manifest.json (built
// by src/assemble/build_compare_manifest.py): populates each window's A/B
// product/cycle/lead selects, swaps the displayed image on selection, and
// drives each window's own opacity slider. Superimpose-only (per direct
// user request 2026-07-17 -- side-by-side was dropped) and two fully
// independent windows (WINDOWS below) instead of one -- every function here
// takes a `win` id first so the same code drives both without duplication.
// Plain vanilla ES2017+, no framework or build step -- this project has no
// npm/bundler anywhere and shouldn't gain one for a page this small.

const WINDOWS = ["1", "2"];
const PANELS = ["a", "b"];

const state = {
  manifest: null,
  panel: {}, // keyed by `${win}-${panel}` -> {productId, cycle, leadH}
};

function panelKey(win, panel) {
  return `${win}-${panel}`;
}

function selector(win, panel, cls) {
  return document.querySelector(`.${cls}[data-window="${win}"][data-panel="${panel}"]`);
}

async function main() {
  const res = await fetch("compare_manifest.json");
  state.manifest = await res.json();

  const productsWithEntries = state.manifest.products.filter((p) => entriesForProduct(p.id).length > 0);

  WINDOWS.forEach((win, winIndex) => {
    // CSS hardcodes the same value as a static fallback (in case this
    // script fails to load at all); setting it here too keeps the real
    // cap data-driven from the one config source
    // (config/compare_layout_presets.yaml) rather than duplicated as a
    // second hardcoded number.
    document.getElementById(`compareStage-${win}`).style.maxWidth = `${state.manifest.target_map_width_px}px`;

    PANELS.forEach((panel) => {
      state.panel[panelKey(win, panel)] = { productId: null, cycle: null, leadH: null };
      populateProductSelect(win, panel);
      selector(win, panel, "product-select")
        .addEventListener("change", (e) => onProductChange(win, panel, e.target.value));
      selector(win, panel, "cycle-select")
        .addEventListener("change", (e) => onCycleChange(win, panel, e.target.value));
      selector(win, panel, "lead-select")
        .addEventListener("change", (e) => onLeadChange(win, panel, e.target.value));
      initFrameScrub(win, panel);
    });
    initOpacitySlider(win);

    // Window 1 defaults to the first two distinct products with real data;
    // window 2 defaults to the next two (wrapping via modulo) so the two
    // windows don't open showing an identical, confusing comparison.
    const n = productsWithEntries.length;
    if (n > 0) {
      selectProduct(win, "a", productsWithEntries[(winIndex * 2) % n].id);
    }
    if (n > 1) {
      selectProduct(win, "b", productsWithEntries[(winIndex * 2 + 1) % n].id);
    } else if (n === 1) {
      selectProduct(win, "b", productsWithEntries[0].id);
    }
  });
}

function entriesForProduct(productId) {
  return state.manifest.entries.filter((e) => e.product_id === productId);
}

function productById(productId) {
  return state.manifest.products.find((p) => p.id === productId);
}

function fmtCycle(iso) {
  const d = new Date(iso);
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hour = String(d.getUTCHours()).padStart(2, "0");
  return `${month} ${day} · ${hour}Z`;
}

function populateProductSelect(win, panel) {
  const select = selector(win, panel, "product-select");
  select.innerHTML = "";
  state.manifest.products.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    const count = entriesForProduct(p.id).length;
    opt.textContent = count > 0 ? p.label : `${p.label} (no data this build)`;
    opt.disabled = count === 0;
    select.appendChild(opt);
  });
}

function selectProduct(win, panel, productId) {
  const select = selector(win, panel, "product-select");
  select.value = productId;
  onProductChange(win, panel, productId);
}

function onProductChange(win, panel, productId) {
  const key = panelKey(win, panel);
  state.panel[key].productId = productId;
  state.panel[key].cycle = null;
  state.panel[key].leadH = null;

  const cycles = [...new Set(entriesForProduct(productId).map((e) => e.cycle))].sort().reverse();
  const cycleSelect = selector(win, panel, "cycle-select");
  cycleSelect.innerHTML = "";
  cycles.forEach((cycle) => {
    const opt = document.createElement("option");
    opt.value = cycle;
    opt.textContent = fmtCycle(cycle);
    cycleSelect.appendChild(opt);
  });

  if (cycles.length > 0) {
    cycleSelect.value = cycles[0];
    onCycleChange(win, panel, cycles[0]);
  } else {
    selector(win, panel, "lead-select").innerHTML = "";
    renderPanel(win, panel, null);
  }
  refreshCalibrationNote(win);
  updateStageAspectRatio(win);
}

function onCycleChange(win, panel, cycle) {
  const key = panelKey(win, panel);
  state.panel[key].cycle = cycle;
  state.panel[key].leadH = null;

  const leads = [...new Set(
    entriesForProduct(state.panel[key].productId)
      .filter((e) => e.cycle === cycle)
      .map((e) => e.lead_h)
  )].sort((x, y) => x - y);

  const leadSelect = selector(win, panel, "lead-select");
  leadSelect.innerHTML = "";
  leads.forEach((leadH) => {
    const opt = document.createElement("option");
    opt.value = leadH;
    opt.textContent = `+${leadH}h`;
    leadSelect.appendChild(opt);
  });

  if (leads.length > 0) {
    leadSelect.value = leads[0];
    onLeadChange(win, panel, String(leads[0]));
  } else {
    renderPanel(win, panel, null);
  }
}

function onLeadChange(win, panel, leadHStr) {
  const leadH = Number(leadHStr);
  const key = panelKey(win, panel);
  state.panel[key].leadH = leadH;
  const entry = entriesForProduct(state.panel[key].productId)
    .find((e) => e.cycle === state.panel[key].cycle && e.lead_h === leadH);
  renderPanel(win, panel, entry || null);
}

// Whichever of the panel's two always-present media elements is currently
// the visible one -- both applyCalibration and initFrameScrub operate on
// "whatever's showing" rather than assuming img.
function activeMediaElement(win, panel) {
  const video = document.getElementById(`video-${win}-${panel}`);
  return video.hidden ? document.getElementById(`img-${win}-${panel}`) : video;
}

// Real .mp4 entries (currently only the satellite loop) get the <video>
// element shown + its own frame-scrub row; everything else gets <img>.
// No separate "kind"/"media" manifest field -- the real path extension
// already tells the two apart unambiguously (see build_compare_manifest's
// own RENDER_EXTENSION-driven glob), so deriving it here can't drift out
// of sync with what's actually on disk.
function renderPanel(win, panel, entry) {
  const viewport = document.getElementById(`viewport-${win}-${panel}`);
  const img = document.getElementById(`img-${win}-${panel}`);
  const video = document.getElementById(`video-${win}-${panel}`);
  const scrubRow = document.getElementById(`scrubRow-${win}-${panel}`);

  if (!entry) {
    viewport.classList.add("empty");
    img.removeAttribute("src");
    img.hidden = false;
    video.pause();
    video.removeAttribute("src");
    video.hidden = true;
    scrubRow.hidden = true;
    return;
  }

  viewport.classList.remove("empty");
  const isVideo = entry.path.endsWith(".mp4");
  if (isVideo) {
    img.hidden = true;
    img.removeAttribute("src");
    video.hidden = false;
    video.src = entry.path;
    // Real, confirmed-live behavior (not the spec assumption this
    // started with): assigning .src resets playbackRate back to 1 --
    // re-applying it here on every selection, not just once at init in
    // initFrameScrub, so 2x survives switching products/cycles/leads.
    video.playbackRate = 2.0;
    scrubRow.hidden = false;
  } else {
    video.pause();
    video.hidden = true;
    video.removeAttribute("src");
    img.hidden = false;
    img.src = entry.path;
    scrubRow.hidden = true;
  }
  applyCalibration(win, panel);
}

// Percentage-based (not fixed-pixel) so the crop/scale stays correct as
// the viewport itself resizes with the browser window -- no resize
// listener needed, the browser recomputes percentages on every reflow.
// left/top/width/height are all expressed relative to the viewport's own
// box, which the shared stage's aspect-ratio (see updateStageAspectRatio)
// already sizes to exactly this preset's map_rect aspect ratio, so the
// media's true source aspect ratio (canvas_w/canvas_h) comes out correct
// regardless of the viewport's actual on-screen pixel size. Works
// identically for <img> and <video> -- both are CSS replaced elements
// sized via the normal box model, confirmed live during the satellite-
// loop-overlay prototype (2026-07-21).
function applyCalibration(win, panel) {
  const el = activeMediaElement(win, panel);
  const product = productById(state.panel[panelKey(win, panel)].productId);
  const presetName = product && product.layout_preset;
  const preset = presetName ? state.manifest.layout_presets[presetName] : null;

  if (!preset) {
    ["width", "height", "left", "top"].forEach((prop) => el.style.removeProperty(prop));
    return;
  }

  const [left, top, w, h] = preset.map_rect;
  el.style.width = `${(preset.canvas_w / w) * 100}%`;
  el.style.height = `${(preset.canvas_h / h) * 100}%`;
  el.style.left = `${(-left / w) * 100}%`;
  el.style.top = `${(-top / h) * 100}%`;
}

// Custom frame scrub for a panel's <video> -- deliberately NOT native
// <video controls> (no built-in scrub bar competing for clicks with the
// overlay/opacity interaction model). Wired ONCE per panel at page init
// (not re-attached per selection, since the <video> element itself is a
// permanent fixture in the DOM -- only its .src changes -- see
// renderPanel's own comment on why both elements always exist). Quantized
// to real frame boundaries via satellite_loop_framerate_fps from the
// manifest (a single source of truth shared with
// render_satellite_loop.FRAMERATE_FPS, not a second hardcoded constant
// here). Verified against a real video in the standalone prototype this
// was built from (data/scratch/satellite_loop/compare_prototype.html).
function initFrameScrub(win, panel) {
  const video = document.getElementById(`video-${win}-${panel}`);
  const scrub = document.getElementById(`frameScrub-${win}-${panel}`);
  const valueLabel = document.getElementById(`frameScrubValue-${win}-${panel}`);
  const playBtn = document.getElementById(`frameScrubPlay-${win}-${panel}`);

  // 2x, per direct user request (2026-07-21). Set here for the element's
  // initial state, but NOT sufficient on its own -- confirmed live that
  // assigning .src resets playbackRate back to 1, so renderPanel's own
  // video branch re-applies this on every selection too.
  video.playbackRate = 2.0;

  const fps = () => state.manifest.satellite_loop_framerate_fps || 4;
  // video.duration = n_frames / fps (ffmpeg's own real encoding convention,
  // src/render/render_satellite_loop.py) -- so duration*fps recovers the
  // real encoded frame count directly, no fencepost +1 needed (a 19-frame
  // video really is 19/4=4.75s, round(4.75*4)=19, matching the real count
  // exactly -- confirmed live, not assumed).
  const frameCount = () => Math.round(video.duration * fps());
  // Clamped: currentTime can legitimately equal duration exactly (seeking
  // to the very end, confirmed live) -- round(duration*fps) then equals
  // frameCount, one past the last real 0-indexed frame, which read as a
  // nonsensical "71 / 70" before this clamp.
  const frameIndex = () => Math.min(Math.round(video.currentTime * fps()), frameCount() - 1);

  video.addEventListener("loadedmetadata", () => {
    scrub.min = 0;
    scrub.max = video.duration;
    scrub.step = 1 / fps(); // one tick per real frame
    scrub.value = 0;
    valueLabel.textContent = `0 / ${frameCount() - 1}`;
    playBtn.textContent = "Play";
  });

  scrub.addEventListener("input", (e) => {
    video.pause();
    playBtn.textContent = "Play";
    video.currentTime = Number(e.target.value);
  });

  video.addEventListener("timeupdate", () => {
    scrub.value = video.currentTime;
    valueLabel.textContent = `${frameIndex()} / ${frameCount() - 1}`;
  });

  // No "ended" listener -- the video element now has the native `loop`
  // attribute (per direct user request 2026-07-21, "go back to the
  // beginning and loop"), and a looping <video> never fires "ended"
  // (HTML spec), so play/pause is the only state the button needs to
  // track.
  playBtn.addEventListener("click", () => {
    if (video.paused) {
      video.play();
      playBtn.textContent = "Pause";
    } else {
      video.pause();
      playBtn.textContent = "Play";
    }
  });
}

// The whole stage (both stacked panels) shares one aspect-ratio box --
// driven by Panel A's own calibration when available, falling back to
// Panel B's, then the CSS default. The two panels' real presets can differ
// by a small amount (documented ~0.3% variance across presets in
// config/compare_layout_presets.yaml) -- a deliberate, accepted
// approximation, not a precision loss that shows up visually.
function updateStageAspectRatio(win) {
  const stage = document.getElementById(`compareStage-${win}`);
  for (const panel of PANELS) {
    const product = productById(state.panel[panelKey(win, panel)].productId);
    const preset = product && product.layout_preset ? state.manifest.layout_presets[product.layout_preset] : null;
    if (preset) {
      const [, , w, h] = preset.map_rect;
      stage.style.aspectRatio = `${w} / ${h}`;
      return;
    }
  }
  stage.style.removeProperty("aspect-ratio");
}

function panelHasCalibration(win, panel) {
  const product = productById(state.panel[panelKey(win, panel)].productId);
  return Boolean(product && product.layout_preset);
}

// Superimpose is the only mode now -- there's no side-by-side fallback to
// drop into when a product has no overlay calibration, so this just warns
// (positions may not line up) instead of disabling anything. In practice
// every real product currently has a calibrated preset (see
// config/compare_layout_presets.yaml); this stays as a defensive note for
// if a future product is added without one.
function refreshCalibrationNote(win) {
  const note = document.getElementById(`calibrationNote-${win}`);
  note.hidden = panelHasCalibration(win, "a") && panelHasCalibration(win, "b");
}

function initOpacitySlider(win) {
  const slider = document.getElementById(`opacitySlider-${win}`);
  const valueLabel = document.getElementById(`opacityValue-${win}`);
  slider.addEventListener("input", (e) => {
    const pct = e.target.value;
    document.getElementById(`compareStage-${win}`).style.setProperty("--overlay-opacity", pct / 100);
    valueLabel.textContent = `${pct}%`;
  });
}

document.addEventListener("DOMContentLoaded", main);
