// Loads the explorer's gzipped uint16 bundles (see src/assemble/
// quantize_bundle.py for the layout) and turns them into Float32 fields.
// Each file is fetched once; at most `concurrency` downloads run at a time.
//
// GitHub Pages serves .gz as plain bytes, so the gzip is undone here with
// DecompressionStream -- unless the bytes don't start with the gzip magic
// number, which means some server already decoded them in transit.

const MISSING = 65535;

async function fetchU16(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  let buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    buf = await new Response(stream).arrayBuffer();
  }
  return new Uint16Array(buf);
}

function dequantize(codes, fieldsMeta, n) {
  const out = {};
  fieldsMeta.forEach((m, i) => {
    const a = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const c = codes[i * n + k];
      a[k] = c === MISSING ? NaN : m.offset + c * m.res;
    }
    out[m.name] = a;
  });
  return out;
}

export class BundleLoader {
  constructor(dataBase, manifest, concurrency = 6) {
    this.base = dataBase;
    this.manifest = manifest;
    this.n = manifest.grid.nlat * manifest.grid.nlon;
    this.cache = new Map();          // path -> Promise<{field: Float32Array}>
    this.decoded = new Map();        // path -> {field: Float32Array}, once resolved
    this.queue = [];
    this.active = 0;
    this.concurrency = concurrency;
    this.bytes = 0;
  }

  entry(model, lead, bundle) {
    return this.manifest.files?.[model]?.[String(lead)]?.[bundle] ?? null;
  }

  has(model, lead, bundle) {
    return this.entry(model, lead, bundle) !== null;
  }

  // Resolves to {fieldName: Float32Array}, or null if the step is missing.
  load(model, lead, bundle) {
    const e = this.entry(model, lead, bundle);
    if (!e) return Promise.resolve(null);
    if (!this.cache.has(e.path)) {
      this.cache.set(e.path, new Promise((resolve, reject) => {
        this.queue.push(async () => {
          try {
            const codes = await fetchU16(`${this.base}/${e.path}`);
            this.bytes += e.bytes;
            const fields = dequantize(codes, e.fields, this.n);
            this.decoded.set(e.path, fields);
            resolve(fields);
          } catch (err) {
            this.cache.delete(e.path);
            reject(err);
          }
        });
        this.pump();
      }));
    }
    return this.cache.get(e.path);
  }

  // Same, but only if already decoded (no waiting); null otherwise.
  ready(model, lead, bundle) {
    const e = this.entry(model, lead, bundle);
    return e ? (this.decoded.get(e.path) ?? null) : null;
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      job().finally(() => { this.active--; this.pump(); });
    }
  }
}
