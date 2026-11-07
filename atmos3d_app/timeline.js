// Time for the explorer, in hours from the model run's T0. Real model steps
// (`leads`) may start before T0: the lead-in steps come from earlier runs'
// analyses and short forecasts (export_atmos3d.step_sources); the forecast
// steps from this run. Observed satellite frames (negative hours) run
// alongside. Anything between two model steps is a display-only blend of its
// neighbours.
export class Timeline {
  // leads: real model steps (h); observed: real observation times (h, <= 0)
  constructor(leads, observed = []) {
    this.playing = false;
    this.stepsPerSecond = 1.6;       // model steps per second of playback
    this.setTimes(leads, observed);
    this.pos = 0;
  }

  setTimes(leads, observed = this.observed ?? []) {
    this.leads = leads;
    this.observed = [...observed].sort((a, b) => a - b);
    this.start = Math.min(leads[0], this.observed.length ? this.observed[0] : 0);
    this.end = leads[leads.length - 1];
    // Every real time you can step to: observation frames, then model steps.
    this.real = [...new Set([...this.observed.filter((h) => h < 0), ...leads])].sort((a, b) => a - b);
    this.pos = Math.min(Math.max(this.pos ?? 0, this.start), this.end);
  }

  get last() { return this.leads.length - 1; }
  get observedPhase() { return this.pos < 0; }
  // True where the model has no data (before its first step).
  get beforeModel() { return this.pos < this.leads[0] - 1e-6; }

  // {i0, i1, t}: the two real model steps around `hours` and the blend
  // weight (0 = i0). Before the first step this is step 0 with t = 0.
  segment(hours = this.pos) {
    const h = Math.min(Math.max(hours, this.leads[0]), this.end);
    let i0 = 0;
    while (i0 < this.last && this.leads[i0 + 1] <= h) i0++;
    if (i0 >= this.last) return { i0: this.last, i1: this.last, t: 0 };
    return { i0, i1: i0 + 1, t: (h - this.leads[i0]) / (this.leads[i0 + 1] - this.leads[i0]) };
  }

  isInterpolated() {
    if (this.beforeModel) return false;
    const { t } = this.segment();
    return t > 1e-3 && t < 1 - 1e-3;
  }

  // Advance while playing (hours per second = model steps per second x the
  // typical 3 h step). `isReady(i)` says whether model step i is loaded;
  // playback holds rather than showing a step it doesn't have yet. The last
  // step rests one step's time before looping to the start.
  tick(dtSeconds, isReady) {
    if (!this.playing) return false;
    const stepH = this.leads.length > 1 ? this.leads[1] - this.leads[0] : 3;
    let next = this.pos + dtSeconds * this.stepsPerSecond * stepH;
    if (next >= this.end + stepH) next = this.start;
    if (next >= this.leads[0]) {
      const { i0, i1 } = this.segment(next);
      if (!isReady(i0) || !isReady(i1)) return false;
    }
    this.pos = next;
    return true;
  }

  // Jump to the previous/next real time (observation frame or model step).
  step(delta) {
    const eps = 1e-6;
    if (delta > 0) this.pos = this.real.find((h) => h > this.pos + eps) ?? this.pos;
    else this.pos = [...this.real].reverse().find((h) => h < this.pos - eps) ?? this.pos;
  }

  // Nearest real time to the current position (used when pausing).
  snap() {
    let best = this.real[0];
    for (const h of this.real) if (Math.abs(h - this.pos) < Math.abs(best - this.pos)) best = h;
    this.pos = best ?? 0;
  }
}
