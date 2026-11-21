// Audio worklets for the TS3 web bridge.
// The bridge always speaks 48 kHz mono in 20 ms frames (960 samples).

const BRIDGE_RATE = 48000;
const FRAME = 960;

const RNN_FRAME = 480; // RNNoise works on 10 ms at 48 kHz
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * RNNoise (neural network noise suppression, see third_party/rnnoise-wasm).
 * Removes keyboard typing, mouse clicks, fans etc. and estimates how likely a
 * frame contains speech. Two builds are supported, used without their
 * Emscripten wrappers:
 * - "strong": RNNoise 0.2 with the newer, larger model (rnnoise-v2.wasm),
 * - "light": the original small model (rnnoise.wasm) for slow devices.
 */
class Denoiser {
  static async create(bytes) {
    const module = await WebAssembly.compile(bytes);
    const light = WebAssembly.Module.imports(module).some((i) => i.module === 'a');
    let mem = null;
    const grow = (requested) => {
      const need = requested - mem.buffer.byteLength;
      if (need <= 0) return 1;
      try { mem.grow(Math.ceil(need / 65536)); return 1; } catch { return 0; }
    };
    const d = new Denoiser();
    d.light = light;
    if (light) {
      const x = (await WebAssembly.instantiate(module, { a: {
        a: grow, // emscripten_resize_heap
        b: (dest, src, n) => { new Uint8Array(mem.buffer).copyWithin(dest, src, src + n); }, // emscripten_memcpy_big
      } })).exports;
      mem = x.c; x.d();
      d.run = x.j; d.state = x.f(0); d.pin = x.g(RNN_FRAME * 4); d.pout = x.g(RNN_FRAME * 4);
    } else {
      const x = (await WebAssembly.instantiate(module, {
        env: { __assert_fail: () => { throw new Error('rnnoise assert'); }, emscripten_resize_heap: grow },
        wasi_snapshot_preview1: { fd_write: () => 0 },
      })).exports;
      mem = x.memory; x.emscripten_stack_init(); x.__wasm_call_ctors();
      d.run = x.rnnoise_process_frame; d.state = x.rnnoise_create(0); d.pin = x.malloc(RNN_FRAME * 4); d.pout = x.malloc(RNN_FRAME * 4);
    }
    d.mem = mem;
    return d;
  }

  /** Denoise a 960-sample frame in place; returns the speech probability (0..1). */
  process(frame) {
    let vad = 0;
    for (let off = 0; off < frame.length; off += RNN_FRAME) {
      const inp = new Float32Array(this.mem.buffer, this.pin, RNN_FRAME);
      for (let i = 0; i < RNN_FRAME; i++) inp[i] = frame[off + i] * 32768;
      vad = Math.max(vad, this.run(this.state, this.pout, this.pin));
      const out = new Float32Array(this.mem.buffer, this.pout, RNN_FRAME);
      for (let i = 0; i < RNN_FRAME; i++) frame[off + i] = out[i] / 32768;
    }
    return vad;
  }
}

/** 2nd order Butterworth high-pass: removes rumble, hum and "plop" below ~80 Hz. */
class HighPass {
  constructor(fc = 80, fs = BRIDGE_RATE) {
    const w = 2 * Math.PI * fc / fs, cs = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2);
    const a0 = 1 + al;
    this.b0 = (1 + cs) / 2 / a0; this.b1 = -(1 + cs) / a0; this.b2 = this.b0;
    this.a1 = -2 * cs / a0; this.a2 = (1 - al) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  process(f) {
    for (let i = 0; i < f.length; i++) {
      const x = f[i];
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      f[i] = y;
    }
  }
}

const dbOf = (x) => 20 * Math.log10(x + 1e-9);

/**
 * Automatic level: brings quiet and loud microphones to the same speech
 * loudness. It only learns while someone speaks (so noise is never pumped up),
 * rises slowly, falls quickly, and a soft limiter prevents clipping.
 */
class AutoLevel {
  constructor() {
    this.target = -23; // dBFS speech level (average of frame levels, about -18 dBFS RMS)
    this.gainDb = 0;
    this.speechDb = null;
  }
  process(f, rms, speech) {
    const prev = Math.pow(10, this.gainDb / 20);
    if (speech && rms > 1e-5) {
      const d = dbOf(rms);
      this.speechDb = this.speechDb == null ? d : this.speechDb + 0.08 * (d - this.speechDb);
      const want = Math.max(-12, Math.min(26, this.target - this.speechDb));
      const step = want > this.gainDb ? 0.15 : 0.6; // dB per 20 ms: up ~7.5 dB/s, down ~30 dB/s
      this.gainDb += Math.max(-step, Math.min(step, want - this.gainDb));
    }
    const next = Math.pow(10, this.gainDb / 20);
    for (let i = 0; i < f.length; i++) {
      let y = f[i] * (prev + (next - prev) * (i / f.length));
      const a = Math.abs(y);
      if (a > 0.7) y = Math.sign(y) * (0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3)); // soft limiter
      f[i] = y;
    }
  }
}

/**
 * Collects microphone input, resamples to 48 kHz and emits 960-sample frames,
 * processed by: manual gain → high-pass → noise filter → automatic level.
 * Also watches the microphone (clipping, very quiet) and the filter's speed.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / BRIDGE_RATE; // input samples per output sample
    this.pos = 0; // fractional read position into `pending`
    this.pending = new Float32Array(0);
    this.frame = new Float32Array(FRAME);
    this.fill = 0;
    this.gain = 1;
    this.denoise = false;
    this.autoLevel = true;
    this.denoiser = null;
    this.hp = new HighPass();
    this.level = new AutoLevel();
    this.stats = { frames: 0, speech: 0, clipped: 0, rawSpeechDb: 0, procMs: 0, procN: 0 };
    this.clipInFrame = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (typeof d.gain === 'number') this.gain = d.gain;
      if (typeof d.denoise === 'boolean') this.denoise = d.denoise;
      if (typeof d.autoLevel === 'boolean') this.autoLevel = d.autoLevel;
      if (d.rnnoise) {
        Denoiser.create(d.rnnoise).then(
          (dn) => { this.denoiser = dn; this.stats.procMs = 0; this.stats.procN = 0; this.port.postMessage({ denoiserReady: dn.light ? 'light' : 'strong' }); },
          (err) => this.port.postMessage({ denoiserError: String(err) }),
        );
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const len = input[0].length;
    // Mix down to mono.
    const mono = new Float32Array(len);
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < len; i++) mono[i] += ch[i];
    }
    if (input.length > 1) for (let i = 0; i < len; i++) mono[i] /= input.length;
    // Clipping happens in the microphone/driver: look at the raw signal.
    for (let i = 0; i < len; i++) if (mono[i] > 0.985 || mono[i] < -0.985) this.clipInFrame++;

    if (this.ratio === 1) {
      this.push(mono);
    } else {
      // Linear resampling with carry-over between blocks.
      const buf = new Float32Array(this.pending.length + len);
      buf.set(this.pending);
      buf.set(mono, this.pending.length);
      const out = [];
      let p = this.pos;
      while (p + 1 < buf.length) {
        const i = Math.floor(p);
        const f = p - i;
        out.push(buf[i] * (1 - f) + buf[i + 1] * f);
        p += this.ratio;
      }
      const keep = Math.floor(p);
      this.pending = buf.slice(keep);
      this.pos = p - keep;
      this.push(Float32Array.from(out));
    }
    return true;
  }

  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      let v = samples[i] * this.gain;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      this.frame[this.fill++] = v;
      if (this.fill === FRAME) {
        this.emit(this.frame);
        this.frame = new Float32Array(FRAME);
        this.fill = 0;
      }
    }
  }

  emit(f) {
    let raw = 0;
    for (let j = 0; j < FRAME; j++) raw += f[j] * f[j];
    const rawRms = Math.sqrt(raw / FRAME);
    this.hp.process(f);
    // -1 = no speech estimate (filter off or not loaded)
    let vad = -1;
    if (this.denoise && this.denoiser) {
      const t = now();
      vad = this.denoiser.process(f);
      this.stats.procMs += now() - t; this.stats.procN++;
    }
    let sum = 0;
    for (let j = 0; j < FRAME; j++) sum += f[j] * f[j];
    const speech = vad >= 0 ? vad >= 0.6 : false;
    if (this.autoLevel) {
      this.level.process(f, Math.sqrt(sum / FRAME), speech);
      sum = 0;
      for (let j = 0; j < FRAME; j++) sum += f[j] * f[j];
    }
    const rms = Math.sqrt(sum / FRAME);

    // microphone check, reported about once per second
    const st = this.stats;
    st.frames++;
    if (speech) { st.speech++; st.rawSpeechDb += dbOf(rawRms); if (this.clipInFrame > 2) st.clipped++; }
    this.clipInFrame = 0;
    if (st.frames >= 50) {
      this.port.postMessage({ diag: {
        speechFrames: st.speech,
        clipRatio: st.speech ? st.clipped / st.speech : 0,
        rawSpeechDb: st.speech ? st.rawSpeechDb / st.speech : null,
        gainDb: this.level.gainDb,
        filterMs: st.procN ? st.procMs / st.procN : null, // per 20 ms frame
        model: this.denoiser ? (this.denoiser.light ? 'light' : 'strong') : null,
      } });
      this.stats = { frames: 0, speech: 0, clipped: 0, rawSpeechDb: 0, procMs: st.procMs, procN: st.procN };
      if (st.procN > 500) { this.stats.procMs = st.procMs / 2; this.stats.procN = st.procN / 2; }
    }
    this.port.postMessage({ frame: f, rms, vad }, [f.buffer]);
  }
}

/** Plays 48 kHz mono frames from the bridge with a small jitter buffer. */
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = BRIDGE_RATE / sampleRate; // bridge samples per output sample
    this.queue = []; // Float32Array chunks
    this.queued = 0; // samples in queue (bridge rate)
    this.offset = 0; // read offset into queue[0] (fractional)
    this.playing = false;
    this.minBuffer = FRAME * 3; // 60 ms before starting
    this.maxBuffer = FRAME * 15; // 300 ms max latency
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.frame) {
        this.queue.push(d.frame);
        this.queued += d.frame.length;
        // Drop old audio when the buffer grows too large (clock drift / bursts).
        while (this.queued > this.maxBuffer && this.queue.length > 1) {
          const dropped = this.queue.shift();
          this.queued -= dropped.length;
          this.offset = 0;
        }
      } else if (d.reset) {
        this.queue = [];
        this.queued = 0;
        this.offset = 0;
        this.playing = false;
      }
    };
  }

  sampleAt(idx) {
    // idx: integer position relative to current chunk start
    let q = 0;
    while (q < this.queue.length && idx >= this.queue[q].length) {
      idx -= this.queue[q].length;
      q++;
    }
    return q < this.queue.length ? this.queue[q][idx] : 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const ch0 = out[0];
    const n = ch0.length;
    if (!this.playing && this.queued >= this.minBuffer) this.playing = true;
    if (this.playing) {
      for (let i = 0; i < n; i++) {
        if (this.queue.length === 0) {
          this.playing = false;
          ch0[i] = 0;
          continue;
        }
        const pos = this.offset;
        const ip = Math.floor(pos);
        const f = pos - ip;
        const a = this.sampleAt(ip);
        const b = f > 0 ? this.sampleAt(ip + 1) : a;
        ch0[i] = a + (b - a) * f;
        this.offset += this.step;
        while (this.queue.length && this.offset >= this.queue[0].length) {
          this.offset -= this.queue[0].length;
          this.queued -= this.queue[0].length;
          this.queue.shift();
        }
      }
    } else {
      ch0.fill(0);
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
registerProcessor('playback-processor', PlaybackProcessor);
