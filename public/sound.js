'use strict';
/**
 * Hollowmere's sound: eerie music and effects, all synthesised live with the
 * Web Audio API. No files to download, nothing to buffer, works offline.
 *
 *   SOUND.unlock()          call from a click — browsers keep audio off until then
 *   MUSIC.lobby()           music box over a church-organ drone, with tape wobble
 *   MUSIC.game()            quieter: low drone, wind, the odd stray piano note
 *   MUSIC.stop()  MUSIC.duck(true|false)  MUSIC.setVolume(0..1)
 *   SFX.dice() .step(i) .door() .thunder() .stamp() .card() .passage()
 *       .sting() .wrong() .solved() .heartbeat() .clock()
 *   VOICE.play(url)         a recorded line (the laugh), ducking the music under it
 */
(() => {
  let ctx = null, master, musicBus, sfxBus, verb, verbIn;
  let musicLevel = 0.5;          // the user-facing slider, 0..1
  let ducked = false;

  // ------------------------------------------------------------ plumbing

  function impulse(seconds, decay) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function unlock() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
    // A long, dark hall reverb everything can send into.
    verb = ctx.createConvolver(); verb.buffer = impulse(3.4, 2.6);
    verbIn = ctx.createGain(); verbIn.gain.value = 0.9;
    verbIn.connect(verb); verb.connect(master);
    musicBus = ctx.createGain(); musicBus.gain.value = 0; musicBus.connect(master);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.8; sfxBus.connect(master);
    applyMusicLevel(1.5);
  }

  const now = () => ctx.currentTime;
  const ready = () => !!ctx;

  function applyMusicLevel(t = 0.8) {
    if (!ctx) return;
    // The slider maps to a gentle curve; 0.5 sits under conversation comfortably.
    const base = Math.pow(musicLevel, 1.6) * 0.55;
    const target = ducked ? base * 0.3 : base;
    musicBus.gain.cancelScheduledValues(now());
    musicBus.gain.setTargetAtTime(target, now(), t / 3);
  }

  function noiseBuffer(seconds, brown) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    return buf;
  }
  let whiteBuf = null, brownBuf = null;
  const white = () => whiteBuf || (whiteBuf = noiseBuffer(2, false));
  const brown = () => brownBuf || (brownBuf = noiseBuffer(4, true));

  /** One shaped note. */
  function tone({ freq, type = 'sine', at = now(), attack = 0.01, dur = 0.5, gain = 0.3, bus = sfxBus, wet = 0.3, detune = 0, glideTo }) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, at); o.detune.value = detune;
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(bus);
    if (wet) { const s = ctx.createGain(); s.gain.value = wet; g.connect(s); s.connect(verbIn); }
    o.start(at); o.stop(at + dur + 0.05);
    return o;
  }

  /** A burst of filtered noise. */
  function burst({ at = now(), dur = 0.1, gain = 0.3, type = 'bandpass', freq = 2000, q = 1, freqTo, useBrown = false, bus = sfxBus, wet = 0.2, attack = 0.003 }) {
    const src = ctx.createBufferSource(); src.buffer = useBrown ? brown() : white();
    src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, at); f.Q.value = q;
    if (freqTo) f.frequency.exponentialRampToValueAtTime(freqTo, at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f); f.connect(g); g.connect(bus);
    if (wet) { const s = ctx.createGain(); s.gain.value = wet; g.connect(s); s.connect(verbIn); }
    src.start(at, Math.random() * 1.5); src.stop(at + dur + 0.05);
  }

  // --------------------------------------------------------------- music
  //
  // Each piece is a set of long-running voices (drones) plus a scheduler that
  // places notes a little ahead of time. Switching pieces crossfades.

  const A = 220;
  const hz = semis => A * Math.pow(2, semis / 12);
  // A natural minor with a raised seventh now and then — the old-film sound.
  const MINOR = [0, 2, 3, 5, 7, 8, 10, 12, 14, 15, 17, 19];

  let piece = null;

  function stopPiece(fade = 2) {
    if (!piece) return;
    const p = piece; piece = null;
    clearInterval(p.timer);
    const t = now();
    p.out.gain.cancelScheduledValues(t);
    p.out.gain.setTargetAtTime(0.0001, t, fade / 4);
    setTimeout(() => { p.voices.forEach(v => { try { v.stop(); } catch (e) {} }); p.out.disconnect(); }, fade * 1000 + 400);
  }

  function newPiece() {
    const out = ctx.createGain(); out.gain.value = 0.0001; out.connect(musicBus);
    const wet = ctx.createGain(); wet.gain.value = 0.6; out.connect(wet); wet.connect(verbIn);
    out.gain.setTargetAtTime(1, now(), 1.2);
    return { out, voices: [], timer: null };
  }

  /** A swelling organ chord: detuned saws through a dark filter, breathing slowly. */
  function organ(p, semis, level) {
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 520; f.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.value = level;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = level * 0.45;
    lfo.connect(lfoG); lfoG.connect(g.gain); lfo.start(); p.voices.push(lfo);
    // tape wobble: the whole chord drifts a few cents, like an old record
    const wow = ctx.createOscillator(); wow.frequency.value = 0.35;
    const wowG = ctx.createGain(); wowG.gain.value = 7;
    wow.connect(wowG); wow.start(); p.voices.push(wow);
    for (const s of semis) for (const d of [-9, 0, 8]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(s); o.detune.value = d;
      wowG.connect(o.detune);
      o.connect(f); o.start(); p.voices.push(o);
    }
    f.connect(g); g.connect(p.out);
    return g;
  }

  /** A music-box tine: bright, fast attack, long shimmer. */
  function tine(p, semis, at, level = 0.16) {
    const f = hz(semis + 12);
    tone({ freq: f, type: 'sine', at, attack: 0.004, dur: 2.2, gain: level, bus: p.out, wet: 0 });
    tone({ freq: f * 3.01, type: 'sine', at, attack: 0.002, dur: 0.6, gain: level * 0.25, bus: p.out, wet: 0 });
  }

  // The lobby tune: a slow waltz on the music box, four bars round and round,
  // every so often a note played a little flat, as if the box were winding down.
  const LOBBY_TUNE = [
    [12, 15, 19], [17, 15, 12], [11, 14, 17], [15, 14, 11],
    [12, 15, 19], [20, 19, 15], [17, 14, 11], [12, null, null]
  ];

  function lobby() {
    if (!ready()) return;
    if (piece && piece.name === 'lobby') return;
    stopPiece(1.5);
    const p = newPiece(); p.name = 'lobby'; piece = p;
    organ(p, [-12, -9, -5], 0.05);                   // A minor, low and wide
    const beat = 0.62;                               // slow three-four
    let bar = 0, next = now() + 0.4;
    p.timer = setInterval(() => {
      while (next < now() + 1.2) {
        const notes = LOBBY_TUNE[bar % LOBBY_TUNE.length];
        notes.forEach((n, i) => {
          if (n === null) return;
          const sour = Math.random() < 0.12 ? -0.35 : 0;
          tine(p, n + sour, next + i * beat + (Math.random() - 0.5) * 0.02, i === 0 ? 0.17 : 0.12);
        });
        // a low bell on the downbeat of every other bar
        if (bar % 2 === 0) tone({ freq: hz(-12 + (bar % 4 === 0 ? 0 : -4)), type: 'triangle', at: next, attack: 0.01, dur: 3.5, gain: 0.07, bus: p.out, wet: 0 });
        next += beat * 3; bar++;
      }
    }, 250);
  }

  function game() {
    if (!ready()) return;
    if (piece && piece.name === 'game') return;
    stopPiece(3);
    const p = newPiece(); p.name = 'game'; piece = p;
    organ(p, [-24, -17], 0.045);                     // a bare fifth, very low: dread
    // wind through the house
    const src = ctx.createBufferSource(); src.buffer = white(); src.loop = true;
    const bf = ctx.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = 500; bf.Q.value = 0.8;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05;
    const lfoG = ctx.createGain(); lfoG.gain.value = 320; lfo.connect(lfoG); lfoG.connect(bf.frequency);
    const wg = ctx.createGain(); wg.gain.value = 0.035;
    src.connect(bf); bf.connect(wg); wg.connect(p.out);
    src.start(); lfo.start(); p.voices.push(src, lfo);
    // stray notes on an out-of-tune piano, never quite a melody
    let next = now() + 2;
    p.timer = setInterval(() => {
      while (next < now() + 1.5) {
        const n = MINOR[Math.floor(Math.random() * MINOR.length)] - (Math.random() < 0.5 ? 12 : 0);
        tone({ freq: hz(n), type: 'triangle', at: next, attack: 0.005, dur: 3.2, gain: 0.07, bus: p.out, wet: 0, detune: (Math.random() - 0.5) * 18 });
        if (Math.random() < 0.3) tone({ freq: hz(n + 3), type: 'triangle', at: next + 0.9, attack: 0.005, dur: 2.6, gain: 0.05, bus: p.out, wet: 0 });
        next += 2.8 + Math.random() * 4.5;
      }
    }, 400);
  }

  const MUSIC = {
    lobby, game,
    stop: () => ready() && stopPiece(2),
    duck(on) { ducked = !!on; applyMusicLevel(0.6); },
    setVolume(v) { musicLevel = Math.max(0, Math.min(1, v)); applyMusicLevel(0.3); },
    get volume() { return musicLevel; },
    get playing() { return piece ? piece.name : null; }
  };

  // ---------------------------------------------------------------- sfx

  const SFX = {
    /** Two dice rattled in a hand, thrown, clattering to a stop. */
    dice() {
      if (!ready()) return;
      const t = now();
      for (let i = 0; i < 9; i++) burst({ at: t + i * 0.045 + Math.random() * 0.02, dur: 0.035, gain: 0.25, freq: 2600 + Math.random() * 1800, q: 4, wet: 0.05 });
      let at = t + 0.55;
      for (let i = 0; i < 7; i++) {
        burst({ at, dur: 0.05, gain: 0.5 * Math.pow(0.78, i), freq: 1500 + Math.random() * 900, q: 3, wet: 0.15 });
        tone({ freq: 180 + Math.random() * 60, at, dur: 0.06, gain: 0.25 * Math.pow(0.8, i), wet: 0.1 });
        at += 0.16 * Math.pow(0.8, i) + 0.02;
      }
    },
    /** A footstep on old boards; alternate feet sound slightly different. */
    step(i = 0) {
      if (!ready()) return;
      const t = now();
      tone({ freq: i % 2 ? 95 : 82, at: t, dur: 0.09, gain: 0.35, wet: 0.25 });
      burst({ at: t, dur: 0.05, gain: 0.08, freq: 900, q: 1, wet: 0.2 });
      if (Math.random() < 0.18) SFX.creak(0.35);    // the occasional loose board
    },
    creak(level = 0.6) {
      if (!ready()) return;
      const t = now();
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(95, t);
      for (let k = 1; k < 10; k++) o.frequency.linearRampToValueAtTime(95 + Math.random() * 70, t + k * 0.08);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1100; f.Q.value = 6;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12 * level, t + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
      const s = ctx.createGain(); s.gain.value = 0.5;
      o.connect(f); f.connect(g); g.connect(sfxBus); g.connect(s); s.connect(verbIn);
      o.start(t); o.stop(t + 0.9);
    },
    /** A heavy door on old hinges, then its weight settling. */
    door() {
      if (!ready()) return;
      SFX.creak(1);
      const t = now();
      tone({ freq: 60, at: t + 0.75, dur: 0.5, gain: 0.45, wet: 0.5 });
      burst({ at: t + 0.75, dur: 0.25, gain: 0.2, type: 'lowpass', freq: 600, wet: 0.5 });
    },
    /** Thunder: a crack, then a long roll that dies away. */
    thunder(dist = 0.5) {
      if (!ready()) return;
      const t = now() + dist * 0.8;
      burst({ at: t, dur: 0.35, gain: 0.5 * (1 - dist * 0.6), type: 'highpass', freq: 1200, wet: 0.6 });
      burst({ at: t + 0.05, dur: 4.5, gain: 0.8, type: 'lowpass', freq: 900, freqTo: 90, useBrown: true, wet: 0.7, attack: 0.08 });
      burst({ at: t + 0.9, dur: 3, gain: 0.5, type: 'lowpass', freq: 300, freqTo: 70, useBrown: true, wet: 0.7, attack: 0.3 });
    },
    /** A rubber stamp slammed onto paper. */
    stamp() {
      if (!ready()) return;
      const t = now();
      tone({ freq: 140, glideTo: 45, at: t, dur: 0.3, gain: 0.6, wet: 0.3 });
      burst({ at: t, dur: 0.07, gain: 0.35, freq: 1800, q: 1, wet: 0.2 });
    },
    /** A playing card slid across a table. */
    card() {
      if (!ready()) return;
      burst({ dur: 0.28, gain: 0.22, type: 'highpass', freq: 2500, freqTo: 6000, wet: 0.1, attack: 0.03 });
    },
    /** Stone grinding, a draught, and something heavy closing behind you. */
    passage() {
      if (!ready()) return;
      const t = now();
      burst({ at: t, dur: 1.6, gain: 0.45, type: 'lowpass', freq: 260, freqTo: 140, useBrown: true, wet: 0.5, attack: 0.2 });
      burst({ at: t + 0.1, dur: 1.2, gain: 0.08, type: 'bandpass', freq: 700, q: 3, wet: 0.4, attack: 0.2 });
      tone({ freq: 55, at: t + 1.5, dur: 0.6, gain: 0.5, wet: 0.6 });
    },
    /** A suggestion put to the table: a dissonant string stab. */
    sting() {
      if (!ready()) return;
      const t = now();
      for (const s of [-12, -11, -5, 1]) tone({ freq: hz(s), type: 'sawtooth', at: t, attack: 0.02, dur: 2.4, gain: 0.07, wet: 0.8 });
      tone({ freq: 55, at: t, dur: 1.6, gain: 0.4, wet: 0.6 });
    },
    /** A wrong accusation: a great bronze gong. */
    wrong() {
      if (!ready()) return;
      const t = now();
      [[65, 0.5], [65 * 2.76, 0.18], [65 * 5.4, 0.1], [65 * 1.5, 0.12]].forEach(([f, g]) =>
        tone({ freq: f, at: t, attack: 0.01, dur: 6, gain: g, wet: 0.9 }));
    },
    /** A case solved: bells climbing out of the minor into the major. */
    solved() {
      if (!ready()) return;
      const t = now();
      [0, 3, 7, 12, 16, 19, 24].forEach((s, i) => tone({ freq: hz(s + 12), at: t + i * 0.16, attack: 0.005, dur: 3, gain: 0.16, wet: 0.7 }));
      tone({ freq: hz(-12), type: 'triangle', at: t, dur: 4, gain: 0.2, wet: 0.7 });
    },
    heartbeat(n = 4) {
      if (!ready()) return;
      const t = now();
      for (let i = 0; i < n; i++) {
        tone({ freq: 55, at: t + i * 0.85, dur: 0.14, gain: 0.5, wet: 0.2 });
        tone({ freq: 48, at: t + i * 0.85 + 0.2, dur: 0.16, gain: 0.35, wet: 0.2 });
      }
    },
    /** The grandfather clock in the hall. */
    clock(strikes = 3) {
      if (!ready()) return;
      const t = now();
      for (let i = 0; i < strikes; i++) {
        tone({ freq: 196, at: t + i * 1.6, attack: 0.003, dur: 3.5, gain: 0.18, wet: 0.8 });
        tone({ freq: 196 * 2.4, at: t + i * 1.6, attack: 0.003, dur: 1.5, gain: 0.05, wet: 0.8 });
      }
    }
  };

  // --------------------------------------------------------------- voice

  const VOICE = {
    /** Play a recorded line; the music drops under it, then comes back. */
    play(url, volume = 1, fallbackText) {
      const speak = () => fallbackText ? VOICE.speak(fallbackText) : MUSIC.duck(false);
      try {
        const a = new Audio(url);
        a.volume = volume;
        MUSIC.duck(true);
        a.onended = () => MUSIC.duck(false);
        a.onerror = speak;                       // no recording? say it with this device's voice
        const pr = a.play();
        if (pr && pr.catch) pr.catch(speak);
        return a;
      } catch (e) { speak(); return null; }
    },
    /** The device's own speech voice — British if there is one — low and slow. */
    speak(text, { pitch = .6, rate = .82 } = {}) {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.pitch = pitch; u.rate = rate;
        const vs = speechSynthesis.getVoices();
        const v = vs.find(v => /Daniel/i.test(v.name)) || vs.find(v => /en-GB/i.test(v.lang));
        if (v) u.voice = v;
        MUSIC.duck(true);
        u.onend = u.onerror = () => MUSIC.duck(false);
        speechSynthesis.cancel(); speechSynthesis.speak(u);
      } catch (e) { MUSIC.duck(false); }
    }
  };

  window.SOUND = { unlock, get ready() { return ready(); } };
  window.MUSIC = MUSIC;
  window.SFX = SFX;
  window.VOICE = VOICE;
})();
