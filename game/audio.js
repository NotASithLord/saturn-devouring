// Saturn Devouring's sample bank on the FTL engine's positional synth (engine/
// audio.js owns the harness: context, master bus, pan/attenuation,
// through-hull far layer, ambience bed, klaxon). Everything here is the
// GAME's sound: a procedural fallback bank plus raw packaged recordings that
// are decoded at first user gesture.

import { balanceRecording } from '../engine/spatial-audio.js';
import { PositionalSynth } from '../engine/audio.js';

// REAL FLOOD AUDIO (user sound audit): the procedural stand-ins here were
// rejected outright — "boom sucks", "death scream is a joke", "scream is the
// WORST" — and real Halo flood recordings were supplied to replace them.
// Downsampled to 22.05 kHz mono and trimmed; a key may carry several takes so
// a repeated cue doesn't machine-gun the same waveform.
const SAMPLES = {
  boom: ['boom.wav', 'boom2.wav'],               // carrier rupture / blast
  // NO SCREAMS (user: "its terrible, just rip it out wholesale"). Both the
  // real takes and the procedural voices are gone, along with every call site
  // — this is not a MUTED entry with the calls left standing.
  // MARINE BARKS: real voice lines, one take each. Deliberately NOT variants —
  // each is spent once per run (see the bark director in main.js).
  bark1: ['bark1.wav'], bark2: ['bark2.wav'], bark3: ['bark3.wav'], bark4: ['bark4.wav'],
  // CARRIER MOVEMENT (user): the bloated form on the move — wet, heavy bulk.
  // Five takes, voiced per carrier while it is actually walking, alongside the
  // stationary gurgle.
  carrier: ['carrier1.wav', 'carrier2.wav', 'carrier3.wav', 'carrier4.wav', 'carrier5.wav'],
};
// KILLED OUTRIGHT by the audit, with no real sample to stand in yet. Dropping
// the buffer is the whole fix — play() no-ops on an unknown name — so every
// call site stays put for whenever a real recording arrives.
const MUTED = ['bounce', 'clack'];

export class GameAudio extends PositionalSynth {
  constructor() {
    super();
    this.ambientOneShot = 'groan'; // hull groans ride the ambience bed
    this._alts = {};
    // AUDIO LOG (user: "so i can see what's playing visually by name"). The
    // sound board on K plays a cue on demand; this records the ones the game
    // fires on its own. Only cues that ACTUALLY reached the master bus land
    // here — play() returns nothing when the name is unknown, the rate limiter
    // swallows the call, or the source is out of earshot, and a cue you never
    // heard has no business in a log of what you heard.
    this.cues = [];        // ring, newest last
    this.onCue = null;     // set by the overlay in main.js
  }

  _note(name, at, far) {
    const c = {
      name, far, t: performance.now(),
      // how far away it went off, so a wall of one cue reads as near or distant
      d: at ? Math.hypot(at.x - this.listener.x, at.z - this.listener.z) : 0,
      positional: !!at,
    };
    this.cues.push(c);
    if (this.cues.length > 64) this.cues.shift();
    this.onCue?.(c);
  }

  // one cue, several takes: swap the chosen take in for the call's duration so
  // the engine's play() needs no notion of variants
  play(name, at = null, vol = 1, key = null, minGapMs = 90) {
    const alts = this._alts[name];
    let r;
    if (alts && alts.length > 1) {
      const saved = this.buffers[name];
      this.buffers[name] = alts[(Math.random() * alts.length) | 0];
      r = super.play(name, at, vol, key, minGapMs);
      this.buffers[name] = saved;
    } else {
      r = super.play(name, at, vol, key, minGapMs);
    }
    if (r) this._note(name, at, false);
    return r;
  }

  // the through-hull layer is a separate entry point in the engine, and a
  // muffled boom two decks down is exactly the kind of thing you open the log
  // to identify — so it is logged too, flagged as far
  playFar(name, at, deckDelta, vol = 1, key = null, minGapMs = 2500) {
    const r = super.playFar(name, at, deckDelta, vol, key, minGapMs);
    if (r) this._note(name, at, true);
    return r;
  }

  // Decode the real takes over the procedural bank. A peerd dwapp reads raw
  // packaged bytes because its CSP deliberately blocks fetch, including blob:
  // URLs; the ordinary website keeps the relative-fetch fallback.
  async _loadSamples() {
    // in parallel — loaded one after another, the last cue in the list was
    // still procedural seconds into the run
    await Promise.all(Object.entries(SAMPLES).map(async ([key, files]) => {
      const bufs = (await Promise.all(files.map(async (f) => {
        try {
          const path = `assets/sounds/${f}`;
          const packed = globalThis.peerd?.assets?.bytes?.(path);
          let bytes;
          if (packed) bytes = packed.slice().buffer;
          else {
            const res = await fetch(`./${path}`);
            if (!res.ok) return null;
            bytes = await res.arrayBuffer();
          }
          return balanceRecording(await this.ctx.decodeAudioData(bytes));
        } catch { return null; } // keep whatever is already in the bank
      }))).filter(Boolean);
      if (bufs.length) { this.buffers[key] = bufs[0]; this._alts[key] = bufs; }
    }));
  }

  // --- procedural sample bank -----------------------------------------------
  _bake() {
    const mk = (sec, fn) => this._mk(sec, fn);
    const rnd = this._rand(1234);

    // rifle crack: noise burst with a fast decaying envelope + low thump
    this.buffers.shot = mk(0.16, (t) => {
      const env = Math.exp(-t * 55);
      return (rnd() * 1.6 * env) + Math.sin(t * 2 * Math.PI * 140) * Math.exp(-t * 40) * 0.7;
    });
    this.buffers.shotFar = mk(0.22, (t) => {
      const env = Math.exp(-t * 26);
      return rnd() * 0.9 * env + Math.sin(t * 2 * Math.PI * 90) * Math.exp(-t * 22) * 0.5;
    });
    // flood host weapon: looser, lower crack
    this.buffers.floodShot = mk(0.2, (t) => {
      const env = Math.exp(-t * 34);
      return rnd() * 1.2 * env + Math.sin(t * 2 * Math.PI * 70) * Math.exp(-t * 25) * 0.8;
    });
    // infection chitter: dry skitter — quieter, faster-decaying clicks so it
    // reads as chitin on deck plate, not a bouncing ball
    this.buffers.chitter = mk(0.3, (t) => {
      const c = (t * 19) % 1; // click phase: sharp attack, fast dry decay
      return rnd() * (c < 0.12 ? 1 : 0) * Math.exp(-c * 40) * 0.6;
    });
    // door hiss
    this.buffers.door = mk(0.3, (t) => rnd() * Math.exp(-t * 9) * 0.4 * Math.min(1, t * 40));
    // grenade / carrier boom
    this.buffers.boom = mk(0.9, (t) =>
      (Math.sin(t * 2 * Math.PI * (55 - t * 30)) * 0.9 + rnd() * 0.8 * Math.exp(-t * 6)) * Math.exp(-t * 4.2));
    // hitmarker tick (UI, non-positional)
    this.buffers.tick = mk(0.05, (t) => Math.sin(t * 2 * Math.PI * 1900) * Math.exp(-t * 90) * 0.6);
    // reload clack + dry click
    this.buffers.clack = mk(0.12, (t) => rnd() * Math.exp(-t * 60) + Math.sin(t * 2 * Math.PI * 400) * Math.exp(-t * 70) * 0.4);
    // grenade bounce
    this.buffers.bounce = mk(0.08, (t) => Math.sin(t * 2 * Math.PI * 240) * Math.exp(-t * 60) * 0.7 + rnd() * 0.2 * Math.exp(-t * 80));
    // FLAMETHROWER ROAR. Deliberately one of the plainest things in the bank:
    // the audit killed the synthetic cues that tried to be clever (a sine
    // sweep for a scream read as a cartoon boing), and a flame is one of the
    // few sounds that IS filtered noise, so there is nothing to fake. Two
    // cascaded one-poles over the seeded noise — a single pole still hisses
    // like a cymbal and it is the second that turns it into air moving — plus
    // a low combustion body under it and a slow incommensurate gutter so a
    // sustained burn never settles into a tremolo. No attack transient: the
    // ignition pop belongs to the weapon, not to the loop, and this cue is
    // retriggered end-to-end while the trigger is held.
    this.buffers.flame = (() => {
      let lp = 0, lp2 = 0;
      return mk(1.1, (t) => {
        lp += (rnd() - lp) * 0.09;      // ~roar band
        lp2 += (lp - lp2) * 0.28;       // second pole kills the hiss
        const body = Math.sin(t * 2 * Math.PI * (58 + Math.sin(t * 2 * Math.PI * 1.9) * 7)) * 0.30;
        const gutter = 0.72 + Math.sin(t * 2 * Math.PI * 5.3) * 0.16 + Math.sin(t * 2 * Math.PI * 11.7) * 0.10;
        // ramped at both ends only enough to stop a click at the seam
        const env = Math.min(1, t * 38) * Math.min(1, (1.1 - t) * 14);
        return (lp2 * 11 + body) * gutter * env * 0.5;
      });
    })();
    // radio blip
    this.buffers.radio = mk(0.16, (t) => Math.sin(t * 2 * Math.PI * (t < 0.08 ? 880 : 660)) * 0.35 * Math.exp(-t * 10));

    // --- horror layer (user: flood sounds and screams nearby) ---------------
    // carrier gurgle: fat bubbling — slow pops through a wet body
    this.buffers.gurgle = mk(1.3, (t) => {
      const pop = Math.sin(t * 2 * Math.PI * (3.1 + Math.sin(t * 5) * 1.2)) > 0.55 ? 1 : 0.25;
      const f = 60 + Math.sin(t * 2 * Math.PI * 1.7) * 18;
      const env = Math.min(1, t * 4) * Math.exp(-Math.max(0, t - 0.9) * 5);
      return (Math.sin(t * 2 * Math.PI * f) * 0.5 + rnd() * 0.4 * pop) * env * 0.7;
    });
    // hull groan: the ship's bones flexing — long metallic moan
    this.buffers.groan = mk(2.2, (t) => {
      const f = 38 + Math.sin(t * 2 * Math.PI * 0.7) * 7;
      const metal = Math.sin(t * 2 * Math.PI * f * 4.7) * 0.18 * Math.exp(-t * 1.2);
      const env = Math.min(1, t * 2) * Math.exp(-Math.max(0, t - 1.4) * 3);
      return (Math.sin(t * 2 * Math.PI * f) * 0.5 + metal + rnd() * 0.05) * env * 0.6;
    });
    // distant muffled battle rumble (other decks) — lowpassed thunder, no bang
    this.buffers.rumble = mk(0.7, (t) => {
      const env = Math.min(1, t * 8) * Math.exp(-t * 4);
      return (Math.sin(t * 2 * Math.PI * (34 - t * 8)) * 0.6 + rnd() * 0.12) * env;
    });
    // ship PA: a two-tone chime, then a voice — garbled past understanding
    // by the dying speakers, but unmistakably the 1MC (user: PA announcements
    // at the big beats)
    this.buffers.pa = mk(3.1, (t) => {
      if (t < 0.55) {
        const f = t < 0.26 ? 660 : 880;
        const seg = t < 0.26 ? t : t - 0.26;
        return Math.sin(t * 2 * Math.PI * f) * 0.32 * Math.min(1, seg * 40) * Math.exp(-seg * 5);
      }
      const tv = t - 0.65;
      if (tv < 0) return 0;
      // syllable gate + formant stack + consonant noise = speech-shaped babble
      const syl = Math.max(0, Math.sin(tv * 2 * Math.PI * 4.6)) ** 0.6;
      const f0 = 118 + Math.sin(tv * 2.2) * 16;
      let v = Math.sin(tv * 2 * Math.PI * f0) * 0.5
        + Math.sin(tv * 2 * Math.PI * f0 * 2) * 0.28
        + Math.sin(tv * 2 * Math.PI * (520 + Math.sin(tv * 7) * 170)) * 0.33
        + Math.sin(tv * 2 * Math.PI * (1350 + Math.sin(tv * 3.1) * 280)) * 0.18;
      v += (rnd() - 0.5) * (syl < 0.3 ? 0.3 : 0.1);
      const env = Math.min(1, tv * 8) * Math.exp(-Math.max(0, tv - 1.9) * 6);
      return v * syl * env * 0.34;
    });
    // far firefight: an irregular burst of dull thumps — rifle fire heard
    // through decks of steel. Played through playFar's lowpass so distance
    // and bulkheads do the muffling.
    this.buffers.farFight = mk(1.5, (t) => {
      // 6 thumps at irregular offsets baked into the buffer
      const offs = [0.02, 0.14, 0.23, 0.55, 0.66, 1.02];
      let v = 0;
      for (const o of offs) {
        const dt = t - o;
        if (dt >= 0 && dt < 0.16) {
          v += Math.sin(dt * 2 * Math.PI * (120 - dt * 180)) * Math.exp(-dt * 34)
            + (rnd() - 0.5) * 0.5 * Math.exp(-dt * 50);
        }
      }
      return v * 0.7;
    });

    for (const k of MUTED) delete this.buffers[k];
    this._loadSamples();
  }
}
