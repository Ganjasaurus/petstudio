/**
 * audio.js: gentle WebAudio sound for the studio (audio rendering).
 *
 * A synthesised plucked "toy piano" voice plays the pet's note events, and a
 * few soft care sounds give tactile feedback. Nothing is downloaded: every
 * sound is synthesised on the device. The AudioContext is created lazily on
 * the first user gesture (browser autoplay rules) and a persisted mute
 * toggle silences everything.
 */
import { drumByMidi } from './teaching-core.js';

const MUTE_KEY = 'petstudio.muted';

export class StudioAudio {
  constructor({ storage = globalThis.localStorage, volume = 0.55 } = {}) {
    this.storage = storage;
    this.volume = volume;
    this.ctx = null;
    this.master = null;
    this.dry = null;
    this.wet = null;
    this.muted = false;
    try {
      this.muted = storage?.getItem(MUTE_KEY) === '1';
    } catch {
      this.muted = false;
    }
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Creates or resumes the AudioContext; call from a user gesture. */
  unlock() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    if (!this.ctx) {
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 3;
      this.master.connect(comp).connect(ctx.destination);
      this.dry = ctx.createGain();
      this.dry.connect(this.master);
      this.wet = ctx.createGain();
      this.wet.gain.value = 0.2;
      const verb = ctx.createConvolver();
      verb.buffer = this._roomImpulse(1.5);
      this.wet.connect(verb).connect(this.master);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return true;
  }

  /** Small procedural "cozy room" reverb tail. */
  _roomImpulse(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3.2;
    }
    return buf;
  }

  setMuted(muted) {
    this.muted = !!muted;
    try {
      this.storage?.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      /* storage unavailable: keep the in-memory setting */
    }
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.04);
    return this.muted;
  }

  toggleMute() {
    return this.setMuted(!this.muted);
  }

  _out(node, pan = 0) {
    let out = node;
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      node.connect(p);
      out = p;
    }
    out.connect(this.dry);
    out.connect(this.wet);
  }

  /** Plucked toy-piano voice: triangle + soft octave sine through a closing low-pass. */
  pluck(midi, { when = 0, duration = 0.35, velocity = 0.6, pan = 0 } = {}) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + Math.max(0, when);
    const f = 440 * 2 ** ((midi - 69) / 12);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = f;
    const over = ctx.createOscillator();
    over.type = 'sine';
    over.frequency.value = f * 2;
    const overGain = ctx.createGain();
    overGain.gain.value = 0.22;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.6;
    filter.frequency.setValueAtTime(Math.min(12000, f * 9), t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(320, f * 1.8), t0 + 0.3 + duration);
    const amp = ctx.createGain();
    const peak = 0.24 * Math.max(0.05, Math.min(1, velocity));
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
    amp.gain.exponentialRampToValueAtTime(peak * 0.35, t0 + 0.14);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration + 0.55);
    osc.connect(filter);
    over.connect(overGain).connect(filter);
    filter.connect(amp);
    this._out(amp, pan);
    const stop = t0 + duration + 0.6;
    osc.start(t0);
    over.start(t0);
    osc.stop(stop);
    over.stop(stop);
  }

  /**
   * Mallet voice for a visiting friend's toy xylophone (Iteration 4): a bright
   * sine with the inharmonic overtone of a struck bar and a quick decay, so
   * its call is easy to tell from the host's plucked keyboard answer.
   */
  mallet(midi, { when = 0, duration = 0.35, velocity = 0.6, pan = 0.3 } = {}) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + Math.max(0, when);
    const f = 440 * 2 ** ((midi - 69) / 12) * 2; // a toy xylophone sounds an octave up
    const peak = 0.2 * Math.max(0.05, Math.min(1, velocity));
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3 + Math.min(0.6, duration * 0.5));
    for (const [mul, level] of [[1, 1], [3.93, 0.28]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f * mul;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(amp);
      osc.start(t0);
      osc.stop(t0 + 1);
    }
    this._out(amp, pan);
  }

  /** Short pitch glide for chirps and bubbly bloops. */
  glide(from, to, { when = 0, duration = 0.14, velocity = 0.35, type = 'sine' } = {}) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + Math.max(0, when);
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(to, t0 + duration);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(0.2 * velocity, t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration + 0.08);
    osc.connect(amp);
    this._out(amp);
    osc.start(t0);
    osc.stop(t0 + duration + 0.1);
  }

  _noise() {
    if (!this.noiseBuffer) {
      const ctx = this.ctx;
      const len = Math.floor(ctx.sampleRate * 0.6);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let seed = 12345;
      for (let i = 0; i < len; i++) {
        seed = (seed * 16807) % 2147483647;
        d[i] = (seed / 2147483647) * 2 - 1;
      }
      this.noiseBuffer = buf;
    }
    return this.noiseBuffer;
  }

  _noiseBurst(t0, { type = 'highpass', freq = 6000, q = 0.7, decay = 0.06, peak = 0.2, pan = 0 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise();
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    src.connect(filter).connect(amp);
    this._out(amp, pan);
    src.start(t0);
    src.stop(t0 + decay + 0.05);
  }

  /** Synthesised percussion for the rhythm pads: kick, clap, hat (hi-hat) and block (wood block). */
  drum(kind, { when = 0, velocity = 0.8, pan = 0 } = {}) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + Math.max(0, when);
    const v = Math.max(0.05, Math.min(1, velocity));
    if (kind === 'kick') {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(150, t0);
      osc.frequency.exponentialRampToValueAtTime(46, t0 + 0.14);
      const amp = ctx.createGain();
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.exponentialRampToValueAtTime(0.75 * v, t0 + 0.005);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
      osc.connect(amp);
      amp.connect(this.dry);
      osc.start(t0);
      osc.stop(t0 + 0.35);
    } else if (kind === 'clap') {
      for (const dt of [0, 0.011, 0.023]) this._noiseBurst(t0 + dt, { type: 'bandpass', freq: 1500, q: 0.9, decay: dt === 0.023 ? 0.16 : 0.03, peak: 0.32 * v, pan });
    } else if (kind === 'hat') {
      this._noiseBurst(t0, { type: 'highpass', freq: 7200, q: 0.6, decay: 0.05, peak: 0.13 * v, pan: pan + 0.2 });
    } else {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(980, t0);
      osc.frequency.exponentialRampToValueAtTime(760, t0 + 0.05);
      const amp = ctx.createGain();
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.exponentialRampToValueAtTime(0.32 * v, t0 + 0.003);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
      osc.connect(amp);
      this._out(amp, pan - 0.15);
      osc.start(t0);
      osc.stop(t0 + 0.12);
    }
  }

  /** Metronome tick (accented on the first beat of a bar). */
  click(accent = false, { when = 0 } = {}) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + Math.max(0, when);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = accent ? 1760 : 1320;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(accent ? 0.16 : 0.1, t0 + 0.002);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
    osc.connect(amp);
    amp.connect(this.dry);
    osc.start(t0);
    osc.stop(t0 + 0.07);
  }

  /** Named care/UI sounds. */
  sfx(name) {
    const seq = (notes, step, opts) => notes.forEach((m, i) => this.pluck(m, { when: i * step, ...opts }));
    switch (name) {
      case 'feed': seq([72, 76, 79], 0.07, { duration: 0.18, velocity: 0.5 }); break;
      case 'wash': [0, 0.09, 0.2].forEach((w, i) => this.glide(420 + i * 120, 900 + i * 160, { when: w, duration: 0.11, velocity: 0.3 })); break;
      case 'sleep': seq([79, 76, 72, 67], 0.11, { duration: 0.3, velocity: 0.32 }); break;
      case 'wake': seq([67, 72, 76, 79], 0.08, { duration: 0.22, velocity: 0.38 }); break;
      case 'pet':
        this.glide(880, 1320, { duration: 0.12, velocity: 0.3 });
        this.glide(990, 1480, { when: 0.13, duration: 0.1, velocity: 0.24 });
        break;
      case 'praise': seq([72, 76, 79, 84], 0.06, { duration: 0.25, velocity: 0.45 }); break;
      case 'go': seq([74, 79], 0.08, { duration: 0.16, velocity: 0.38 }); break;
      case 'complete': seq([76, 79, 84], 0.09, { duration: 0.3, velocity: 0.42 }); break;
      case 'refuse':
        this.pluck(64, { duration: 0.14, velocity: 0.38 });
        this.pluck(60, { when: 0.16, duration: 0.24, velocity: 0.38 });
        break;
      case 'decline': this.pluck(67, { duration: 0.12, velocity: 0.25 }); break;
      case 'tap': this.glide(520, 660, { duration: 0.04, velocity: 0.12, type: 'triangle' }); break;
      case 'lesson': seq([72, 79, 76], 0.09, { duration: 0.22, velocity: 0.36 }); break;
      case 'love': seq([76, 81, 84, 88], 0.07, { duration: 0.28, velocity: 0.42 }); break;
      case 'hang':
        this.glide(330, 520, { duration: 0.12, velocity: 0.3, type: 'triangle' });
        seq([79, 84], 0.1, { duration: 0.3, velocity: 0.36 });
        break;
      case 'visit': // ding-dong: a friend arrives
        this.mallet(76, { velocity: 0.55 });
        this.mallet(72, { when: 0.22, velocity: 0.5 });
        break;
      case 'bye':
        this.mallet(72, { velocity: 0.45 });
        this.mallet(67, { when: 0.2, velocity: 0.4 });
        break;
      case 'learn': seq([72, 76, 79], 0.08, { duration: 0.22, velocity: 0.36 }); break;
      default: break;
    }
  }
}

/** Encodes 1 or 2 Float32Array PCM channels into a standard 16-bit RIFF WAVE Blob. */
export function encodeWavPcm16(channels, sampleRate = 44100) {
  const numChannels = Math.max(1, Math.min(2, channels.length));
  const numFrames = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = numFrames * blockAlign;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true);  // format = 1 (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i] || 0));
      view.setInt16(offset, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
      offset += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Renders a Pet Studio phrase (toy-piano pluck, optional duet xylophone mallet,
 * and rhythm-pad drums) offline into a 16-bit stereo WAV Blob (`audio/wav`).
 */
export async function renderPhraseToWav(phrase, { duetSplit = null, sampleRate = 44100 } = {}) {
  const tempo = Math.max(40, Math.min(240, Number(phrase?.tempo) || 110));
  const beats = Math.max(1, Number(phrase?.beats) || 8);
  const spb = 60 / tempo;
  const notes = Array.isArray(phrase?.notes) ? phrase.notes : [];
  const hits = Array.isArray(phrase?.hits) ? phrase.hits : [];
  let endSec = beats * spb + 0.85;
  for (const n of notes) {
    endSec = Math.max(endSec, 0.05 + Math.max(0, n.beat) * spb + Math.max(0.08, (n.dur ?? 0.5) * spb) + 0.7);
  }
  for (const h of hits) {
    endSec = Math.max(endSec, 0.05 + Math.max(0, h.beat) * spb + 0.45);
  }
  const totalFrames = Math.max(Math.floor(sampleRate * 0.5), Math.ceil(endSec * sampleRate));
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;

  if (OAC) {
    const ctx = new OAC(2, totalFrames, sampleRate);
    const master = ctx.createGain();
    master.gain.value = 0.82;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    master.connect(comp).connect(ctx.destination);
    const dry = ctx.createGain();
    dry.connect(master);
    const wet = ctx.createGain();
    wet.gain.value = 0.2;

    // Deterministic cozy room impulse
    const irLen = Math.floor(sampleRate * 1.3);
    const irBuf = ctx.createBuffer(2, irLen, sampleRate);
    let irSeed = 98765;
    for (let c = 0; c < 2; c++) {
      const d = irBuf.getChannelData(c);
      for (let i = 0; i < irLen; i++) {
        irSeed = (irSeed * 16807) % 2147483647;
        d[i] = ((irSeed / 2147483647) * 2 - 1) * (1 - i / irLen) ** 3.2;
      }
    }
    const verb = ctx.createConvolver();
    verb.buffer = irBuf;
    wet.connect(verb).connect(master);

    // Deterministic noise buffer for percussion
    const noiseLen = Math.floor(sampleRate * 0.6);
    const noiseBuf = ctx.createBuffer(1, noiseLen, sampleRate);
    const nd = noiseBuf.getChannelData(0);
    let nSeed = 12345;
    for (let i = 0; i < noiseLen; i++) {
      nSeed = (nSeed * 16807) % 2147483647;
      nd[i] = (nSeed / 2147483647) * 2 - 1;
    }

    const connectOut = (node, pan = 0) => {
      let out = node;
      if (pan && ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, pan));
        node.connect(p);
        out = p;
      }
      out.connect(dry);
      out.connect(wet);
    };

    const noiseBurst = (t0, { type = 'highpass', freq = 6000, q = 0.7, decay = 0.06, peak = 0.2, pan = 0 } = {}) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      const amp = ctx.createGain();
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
      src.connect(filter).connect(amp);
      connectOut(amp, pan);
      src.start(t0);
      src.stop(t0 + decay + 0.05);
    };

    for (const note of notes) {
      const t0 = 0.05 + Math.max(0, note.beat) * spb;
      const duration = Math.max(0.08, (note.dur ?? 0.5) * spb);
      const velocity = Math.max(0.05, Math.min(1, note.vel ?? 0.7));
      if (duetSplit != null && note.beat < duetSplit) {
        const f = 440 * 2 ** ((note.midi - 69) / 12) * 2;
        const peak = 0.2 * velocity;
        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0.0001, t0);
        amp.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
        amp.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3 + Math.min(0.6, duration * 0.5));
        for (const [mul, level] of [[1, 1], [3.93, 0.28]]) {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = f * mul;
          const g = ctx.createGain();
          g.gain.value = level;
          osc.connect(g).connect(amp);
          osc.start(t0);
          osc.stop(t0 + 1);
        }
        connectOut(amp, 0.35);
      } else {
        const f = 440 * 2 ** ((note.midi - 69) / 12);
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = f;
        const over = ctx.createOscillator();
        over.type = 'sine';
        over.frequency.value = f * 2;
        const overGain = ctx.createGain();
        overGain.gain.value = 0.22;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = 0.6;
        filter.frequency.setValueAtTime(Math.min(12000, f * 9), t0);
        filter.frequency.exponentialRampToValueAtTime(Math.max(320, f * 1.8), t0 + 0.3 + duration);
        const amp = ctx.createGain();
        const peak = 0.24 * velocity;
        amp.gain.setValueAtTime(0.0001, t0);
        amp.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
        amp.gain.exponentialRampToValueAtTime(peak * 0.35, t0 + 0.14);
        amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration + 0.55);
        osc.connect(filter);
        over.connect(overGain).connect(filter);
        filter.connect(amp);
        connectOut(amp, note.midi <= 70 ? -0.2 : 0.2);
        const stop = t0 + duration + 0.6;
        osc.start(t0);
        over.start(t0);
        osc.stop(stop);
        over.stop(stop);
      }
    }

    for (const hit of hits) {
      const t0 = 0.05 + Math.max(0, hit.beat) * spb;
      const v = Math.max(0.05, Math.min(1, hit.vel ?? 0.8));
      const kind = drumByMidi(hit.midi)?.id ?? 'block';
      if (kind === 'kick') {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(150, t0);
        osc.frequency.exponentialRampToValueAtTime(46, t0 + 0.14);
        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0.0001, t0);
        amp.gain.exponentialRampToValueAtTime(0.75 * v, t0 + 0.005);
        amp.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
        osc.connect(amp);
        amp.connect(dry);
        osc.start(t0);
        osc.stop(t0 + 0.35);
      } else if (kind === 'clap') {
        for (const dt of [0, 0.011, 0.023]) {
          noiseBurst(t0 + dt, { type: 'bandpass', freq: 1500, q: 0.9, decay: dt === 0.023 ? 0.16 : 0.03, peak: 0.32 * v });
        }
      } else if (kind === 'hat') {
        noiseBurst(t0, { type: 'highpass', freq: 7200, q: 0.6, decay: 0.05, peak: 0.13 * v, pan: 0.2 });
      } else {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(980, t0);
        osc.frequency.exponentialRampToValueAtTime(760, t0 + 0.05);
        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0.0001, t0);
        amp.gain.exponentialRampToValueAtTime(0.32 * v, t0 + 0.003);
        amp.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
        osc.connect(amp);
        connectOut(amp, -0.15);
        osc.start(t0);
        osc.stop(t0 + 0.12);
      }
    }

    const rendered = await ctx.startRendering();
    const chs = [];
    for (let c = 0; c < rendered.numberOfChannels; c++) chs.push(rendered.getChannelData(c));
    return encodeWavPcm16(chs, rendered.sampleRate);
  }

  // Pure-JS software synth fallback for headless Node environments without WebAudio
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);
  const tri = (phase) => {
    const u = phase - Math.floor(phase);
    return u < 0.5 ? u * 4 - 1 : 3 - u * 4;
  };
  for (const note of notes) {
    const t0 = 0.05 + Math.max(0, note.beat) * spb;
    const duration = Math.max(0.08, (note.dur ?? 0.5) * spb);
    const v = Math.max(0.05, Math.min(1, note.vel ?? 0.7));
    const isMallet = duetSplit != null && note.beat < duetSplit;
    const f = 440 * 2 ** ((note.midi - 69) / 12) * (isMallet ? 2 : 1);
    const startIdx = Math.floor(t0 * sampleRate);
    const lenIdx = Math.min(totalFrames - startIdx, Math.floor((duration + 0.55) * sampleRate));
    const pan = isMallet ? 0.35 : note.midi <= 70 ? -0.2 : 0.2;
    const gainL = Math.cos(((pan + 1) * Math.PI) / 4);
    const gainR = Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < lenIdx; i++) {
      const dt = i / sampleRate;
      const env = dt < 0.006 ? dt / 0.006 : Math.exp(-dt / Math.max(0.12, duration * 0.55));
      const sig = isMallet
        ? (Math.sin(2 * Math.PI * f * dt) + 0.28 * Math.sin(2 * Math.PI * f * 3.93 * dt)) * 0.22 * v * env
        : (tri(f * dt) * 0.78 + Math.sin(2 * Math.PI * f * 2 * dt) * 0.22) * 0.28 * v * env;
      left[startIdx + i] += sig * gainL;
      right[startIdx + i] += sig * gainR;
    }
  }
  let rng = 12345;
  for (const hit of hits) {
    const t0 = 0.05 + Math.max(0, hit.beat) * spb;
    const v = Math.max(0.05, Math.min(1, hit.vel ?? 0.8));
    const kind = drumByMidi(hit.midi)?.id ?? 'block';
    const startIdx = Math.floor(t0 * sampleRate);
    const dur = kind === 'kick' ? 0.3 : kind === 'clap' ? 0.18 : 0.09;
    const lenIdx = Math.min(totalFrames - startIdx, Math.floor(dur * sampleRate));
    for (let i = 0; i < lenIdx; i++) {
      const dt = i / sampleRate;
      rng = (rng * 16807) % 2147483647;
      const noise = (rng / 2147483647) * 2 - 1;
      let sig = 0;
      if (kind === 'kick') sig = Math.sin(2 * Math.PI * (46 + 104 * Math.exp(-dt * 18)) * dt) * Math.exp(-dt * 10) * 0.6 * v;
      else if (kind === 'clap') sig = noise * Math.exp(-dt * 16) * 0.25 * v;
      else if (kind === 'hat') sig = noise * Math.exp(-dt * 38) * 0.14 * v;
      else sig = tri(840 * dt) * Math.exp(-dt * 28) * 0.28 * v;
      left[startIdx + i] += sig;
      right[startIdx + i] += sig;
    }
  }
  return encodeWavPcm16([left, right], sampleRate);
}
