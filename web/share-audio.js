'use strict';
/* Funkraum – sound for the screen sharing in browsers without
 * MediaStreamTrackProcessor (Firefox, Safari): hands over 20 ms blocks
 * (planar float, at most two channels) to share.js, which encodes them. */
class ShareCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 50);
    this.ch = 0;
    this.buf = null;
    this.n = 0;
  }

  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const ch = Math.min(2, inp.length);
    if (ch !== this.ch) {
      this.ch = ch;
      this.buf = Array.from({ length: ch }, () => new Float32Array(this.size));
      this.n = 0;
    }
    const len = inp[0].length;
    let off = 0;
    while (off < len) {
      const k = Math.min(len - off, this.size - this.n);
      for (let c = 0; c < ch; c++) this.buf[c].set(inp[c].subarray(off, off + k), this.n);
      this.n += k;
      off += k;
      if (this.n === this.size) {
        const data = new Float32Array(this.size * ch);
        for (let c = 0; c < ch; c++) data.set(this.buf[c], c * this.size);
        this.port.postMessage({ ch, frames: this.size, data }, [data.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('share-capture', ShareCapture);
