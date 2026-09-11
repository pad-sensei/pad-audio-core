// ========================================
// AUDIO VOICE MANAGEMENT
// ========================================
// Split from audio.js (Phase 0.1.g / 2026-04-13). Owns:
//   - Per-voice soft saturation (_createVoiceSaturation)
//   - Voice tracking (activeVoices map)
//   - Mute button UI + state (_updateMuteBtn / toggleSoundMute)
//   - noteOn / noteOff / noteOffAll / setSustain
//   - Velocity curve (applyVelocityCurve / drawVelocityCurve)
//   - Global held-note tracking (mouse / touch / blur)
//   - playMidiNotes helper
//
// Depends on audio-master.js (audioCtx / masterGain / _soundMuted /
// _useEpianoWorklet), audio-reverb.js (epianoDirectOut / epianoAmpOut /
// epianoReverbSend), audio-effects.js (triggerAutoFilter), audio-engines.js
// (AudioState), audio-overlay.js (_hidePadHint), audio-persistence.js
// (saveSoundSettings), audio-sampler.js (_samplerNoteOn), audio.js
// (ensureAudioResumed / _ensureWafPlayer / wafPlayer), epiano-engine.js
// (EP_AMP_PRESETS / EpState / epianoNoteOn / epianoWorkletNoteOn /
// epianoWorkletSetSustain), and AppState from data.js.
// ========================================

// --- Velocity-driven saturation (soft clipping) ---
let saturationDrive = 0; // 0=off, 0.1-1.0=mild-heavy

function _createVoiceSaturation(velocity) {
  if (saturationDrive === 0) return { input: masterGain, cleanup: null };
  var ws = audioCtx.createWaveShaper();
  // Drive scales with velocity squared: low vel → clean, high vel → gritty
  var velDrive = 1 + velocity * velocity * saturationDrive * 20;
  var n = 256, curve = new Float32Array(n);
  var tanhD = Math.tanh(velDrive);
  for (var i = 0; i < n; i++) {
    var x = (i * 2) / n - 1;
    curve[i] = Math.tanh(x * velDrive) / tanhD;
  }
  ws.curve = curve;
  ws.oversample = '2x';
  ws.connect(masterGain);
  return {
    input: ws,
    cleanup: function() { try { ws.disconnect(); } catch(_) {} }
  };
}

// --- Voice management ---
const activeVoices = new Map(); // midi → { envelope, satCleanup, engineHandlesSustain }
// Engines without their own damper implementation (sampler / WebAudioFont /
// non-worklet fallback) keep released keys here while CC64 is held. The e-piano
// AudioWorklet still receives NoteOff immediately and owns its sustain internally.
const _sustainDeferredNotes = new Set();

function _cancelVoiceNow(midi, voice) {
  const v = voice || activeVoices.get(midi);
  if (!v) {
    _sustainDeferredNotes.delete(midi);
    return false;
  }
  try { v.envelope.cancel(); } catch(_){}
  if (v.satCleanup) setTimeout(v.satCleanup, 2000);
  activeVoices.delete(midi);
  _sustainDeferredNotes.delete(midi);
  return true;
}

// Phase 3.0.c1: mute UI is host-owned. SVG icons + DOM updates moved to
// host-adapter.js. _updateMuteBtn becomes a thin delegator. If host
// doesn't provide muteUI bridge (standalone), no-op silently.
function _updateMuteBtn() {
  var b = (typeof window !== 'undefined' && window.audioCoreConfig)
    ? window.audioCoreConfig.muteUI : null;
  if (!b) return;
  if (b.updateMuteBtn) b.updateMuteBtn(_soundMuted);
  if (b.updatePresetOpacity) b.updatePresetOpacity(_soundMuted);
}

function toggleSoundMute() {
  _soundMuted = !_soundMuted;
  _updateMuteBtn();
  // 2026-04-15 fix: also apply to audio output (existing voices keep playing
  // otherwise; noteOn _soundMuted guard only blocks new triggers).
  var b = (typeof window !== 'undefined' && window.audioCoreConfig)
    ? window.audioCoreConfig.muteUI : null;
  if (b && b.applyMute) b.applyMute(_soundMuted);
  saveSoundSettings();
}

function noteOn(midi, velocity, outputGain, _retries) {
  velocity = velocity || 0.8;
  if (outputGain === undefined) outputGain = 1.0;
  if (_soundMuted) return;
  ensureAudioResumed();
  _hidePadHint();
  // Kill same note if re-triggered
  const existing = activeVoices.get(midi);
  if (existing) {
    // Re-trigger always replaces the old voice, including one currently held only
    // by the sustain pedal. Never let a deferred release kill the new attack later.
    _cancelVoiceNow(midi, existing);
  }

  triggerAutoFilter();

  // Per-voice saturation chain (velocity-driven)
  var sat = _createVoiceSaturation(velocity);

  // Route to physics engine, sampler, or WebAudioFont
  let envelope;
  if (AudioState.instrument.epiano) {
    // Physics engine: bypass per-voice saturation (physics chain has 3 nonlinear stages)
    if (sat.cleanup) sat.cleanup();
    EpState.preset = AudioState.instrument.epiano;
    // Room reverb always available (REV knob controls level).
    // Spring reverb is separate (inside amp chain, controlled by E.Piano Mixer).
    var epPreset = EP_AMP_PRESETS[EpState.preset];
    epianoReverbSend.gain.setValueAtTime(1.0, audioCtx.currentTime);
    // DI mode → effects chain (epianoDirectOut). Amp mode → masterBus direct (epianoAmpOut).
    var epDest = (epPreset && epPreset.useCabinet) ? epianoAmpOut : epianoDirectOut;
    envelope = _useEpianoWorklet
      ? epianoWorkletNoteOn(audioCtx, midi, velocity, epDest, outputGain)
      : epianoNoteOn(audioCtx, midi, velocity, epianoDirectOut);
  } else if (AudioState.instrument.sampler) {
    envelope = _samplerNoteOn(AudioState.instrument.sampler, midi, velocity, sat.input);
  } else {
    if (!_ensureWafPlayer()) return;
    envelope = wafPlayer.queueWaveTable(
      audioCtx, sat.input, AudioState.instrument.data,
      0, midi, 99999, velocity
    );
  }
  if (!envelope) {
    if (sat.cleanup) sat.cleanup();
    _retries = _retries || 0;
    if (_retries < 3) {
      setTimeout(() => noteOn(midi, velocity, outputGain, _retries + 1), 100);
    }
    return;
  }
  activeVoices.set(midi, {
    envelope,
    satCleanup: sat.cleanup,
    // Worklet e-piano needs NoteOff immediately; its DSP holds/releases the voice
    // from epianoWorkletSetSustain(). Other engines need host-side deferral.
    engineHandlesSustain: !!(AudioState.instrument.epiano && _useEpianoWorklet),
  });
}

function noteOff(midi) {
  const v = activeVoices.get(midi);
  if (!v) return;

  if (_sustainOn && !v.engineHandlesSustain) {
    _sustainDeferredNotes.add(midi);
    return;
  }

  // Worklet e-piano receives NoteOff even while sustain is down so its DSP can
  // move the key into its own sustainPending state. Generic engines release here.
  _cancelVoiceNow(midi, v);
}

function noteOffAll() {
  for (const [midi, v] of [...activeVoices.entries()]) {
    _cancelVoiceNow(midi, v);
  }
  _sustainDeferredNotes.clear();
  // Kill any lingering WebAudioFont voices not tracked in activeVoices
  if (wafPlayer) wafPlayer.cancelQueue(audioCtx);
}

// Sustain pedal (MIDI CC64). The e-piano worklet owns damper state internally;
// engines without a native sustain contract defer host-side NoteOff until pedal-up.
var _sustainOn = false;
function setSustain(on) {
  _sustainOn = !!on;
  if (_useEpianoWorklet && typeof epianoWorkletSetSustain === 'function') {
    epianoWorkletSetSustain(_sustainOn);
  }

  if (!_sustainOn && _sustainDeferredNotes.size > 0) {
    [..._sustainDeferredNotes].forEach(function(midi) {
      const v = activeVoices.get(midi);
      if (v && !v.engineHandlesSustain) _cancelVoiceNow(midi, v);
      else _sustainDeferredNotes.delete(midi);
    });
  }
}

// --- Velocity curve (Push 3-style 4-parameter) ---
function applyVelocityCurve(velocity127) {
  const { velThreshold, velDrive, velCompand, velRange } = AppState;
  if (velocity127 <= velThreshold) return 0;
  let x = (velocity127 - velThreshold) / (127 - velThreshold);
  // Drive: power curve (+drive → concave/soft=loud, -drive → convex/need harder)
  const exp = Math.pow(2, -velDrive / 32);
  x = Math.pow(x, exp);
  // Compand: compress(+)/expand(-) dynamic range
  if (velCompand !== 0) {
    const c = velCompand / 64;
    if (c > 0) {
      x = x + c * (0.7 - x) * x * 2;
    } else {
      const a = -c;
      x = x < 0.5
        ? 0.5 * Math.pow(2 * x, 1 + a * 2)
        : 1 - 0.5 * Math.pow(2 * (1 - x), 1 + a * 2);
    }
  }
  return Math.min(1, Math.max(0, x)) * (velRange / 127);
}

function drawVelocityCurve() {
  const canvas = document.getElementById('vel-curve-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
  ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
  ctx.stroke();
  // Diagonal reference (linear)
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  ctx.moveTo(0, h); ctx.lineTo(w, 0);
  ctx.stroke();
  // Velocity curve
  ctx.strokeStyle = '#00d4ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= w; i++) {
    const vel127 = (i / w) * 127;
    const out = applyVelocityCurve(vel127);
    const y = h - out * h;
    i === 0 ? ctx.moveTo(i, y) : ctx.lineTo(i, y);
  }
  ctx.stroke();
}

// Global held-note tracking (mouse / touch)
let _heldMidi = null;
const _heldTouches = new Map(); // touch.identifier → midi

// Phase 3.0.b: linkMode / midiActiveNotes / scheduleMidiUpdate への直接参照を
// host-adapter.js の audioCoreConfig.midiBridge 経由に変更。
// host が config を提供しない場合は no-op（standalone 等）。
function _midiBridgeRelease(midi) {
  var b = (typeof window !== 'undefined' && window.audioCoreConfig)
    ? window.audioCoreConfig.midiBridge : null;
  if (b && b.isLinkMode && b.isLinkMode()) {
    if (b.onNoteReleased) b.onNoteReleased(midi);
  }
}
function _midiBridgeReleaseAll() {
  var b = (typeof window !== 'undefined' && window.audioCoreConfig)
    ? window.audioCoreConfig.midiBridge : null;
  if (b && b.isLinkMode && b.isLinkMode()) {
    if (b.onAllReleased) b.onAllReleased();
  }
}

document.addEventListener('mouseup', () => {
  if (_heldMidi !== null) {
    noteOff(_heldMidi);
    _midiBridgeRelease(_heldMidi);
    _heldMidi = null;
  }
});
document.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) {
    const midi = _heldTouches.get(t.identifier);
    if (midi !== undefined) {
      noteOff(midi); _heldTouches.delete(t.identifier);
      _midiBridgeRelease(midi);
    }
  }
});
document.addEventListener('touchcancel', (e) => {
  for (const t of e.changedTouches) {
    const midi = _heldTouches.get(t.identifier);
    if (midi !== undefined) {
      noteOff(midi); _heldTouches.delete(t.identifier);
      _midiBridgeRelease(midi);
    }
  }
});
// Safety: if window loses focus while holding, release all notes
window.addEventListener('blur', () => {
  if (_heldMidi !== null) { noteOff(_heldMidi); _heldMidi = null; }
  _heldTouches.forEach((midi) => noteOff(midi));
  _heldTouches.clear();
  _midiBridgeReleaseAll();
});

function playMidiNotes(midiNotes) {
  midiNotes.forEach(m => noteOn(m, undefined, 1.0)); // chord: default outputGain=1.0
  setTimeout(() => { midiNotes.forEach(m => noteOff(m)); }, 600);
}
