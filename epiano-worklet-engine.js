// ========================================
// E-PIANO WORKLET ENGINE (Main Thread)
// ========================================
// Manages AudioWorkletNode for e-piano DSP.
// Signal flow:
//   EpianoWorkletNode ch0 → masterDest (V4B/poweramp/cabinet all inside worklet)
//
// All DSP runs in epiano-worklet-processor.js. This file handles:
//   - AudioWorklet registration and node creation
//   - noteOn/noteOff via MessagePort
//   - Parameter updates via MessagePort

// --- State ---
var _epw_node = null;          // AudioWorkletNode
var _epw_initialized = false;
var _epw_initPromise = null;  // Promise cache to prevent concurrent init race
// V4B, poweramp, cabinet all run inside worklet now (sample-by-sample)

// Current parameters (mirrored for UI reads)
var EpwState = {
  pickupSymmetry: 0.3,
  pickupDistance: 0.5,
  pickupBassDriveBoost: 1.5,
  pickupBassBoost: 1.5,
  pickupBassMinRatio: 0.75,
  pickupMinRatio: 0.7,
  gapVoicing: 'dyno', // 'factory' | 'dyno' (D-3 A/B 切替)
  fNewEnabled: true,  // F-NEW 磁化体積項 (D-12 2026-04-25 A/B 切替)
  puPosBassDriveEnabled: true, // Step 2: PU 非線形ゾーン到達深さ (D-12 2026-04-25 A/B 切替)
  preampGain: 1.0,
  tonestackBass: 0.5,
  tonestackMid: 0.5,
  tonestackTreble: 0.5,
  preset: 'Rhodes DI',
  use2ndPreamp: true,
  brightSwitch: false,
  springReverbMix: 0.12,
  springDwell: 6.0,
  puModel: 'cylinder', // 'cylinder' or 'dipole' (A/B comparison)
  whirlEnabled: true,  // 2D tine whirling on/off
  beamDecayR: 0,       // 0=per-key curve (default). >0=global override for calibration
};

// ========================================
// INIT
// ========================================

function epianoWorkletInit(ctx, masterDest) {
  if (_epw_initialized) return Promise.resolve();
  if (_epw_initPromise) return _epw_initPromise;  // in-flight init — return existing promise

  // Submodule-aware path: this engine lives under audio-core/, and
  // AudioWorklet.addModule resolves relative to document.baseURL (the
  // host page), so we need the audio-core/ prefix here. When audio-core
  // is later consumed outside a submodule (future standalone web audio
  // app, JUCE WebView plugin), the host app can set window.AUDIO_CORE_BASE
  // to override.
  var basePath = (typeof window !== 'undefined' && window.AUDIO_CORE_BASE) || 'audio-core/';
  var processorUrl = basePath + 'epiano-worklet-processor.js?v=' + (window.APP_VERSION || Date.now());
  _epw_initPromise = ctx.audioWorklet.addModule(processorUrl).then(function() {
    // Create worklet node (mono output: all DSP inside worklet)
    // V4B, poweramp, cabinet now run sample-by-sample in the worklet.
    // Eliminates 128-sample block jitter at nonlinear stages (framework §3).
    _epw_node = new AudioWorkletNode(ctx, 'epiano-worklet-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],  // Stereo: Suitcase tremolo uses L/R
    });

    // ch0 → masterDest (worklet output is already fully processed)
    _epw_node.connect(masterDest);

    // Debug: forward worklet gain measurements to main-thread console
    _epw_node.port.onmessage = function(e) {
      if (e.data && e.data.type === 'debug') {
        console.log('[GAIN] V2Bin=' + (e.data.v2bIn||0).toFixed(4) + ' V2Bout=' + e.data.v2b.toFixed(4) + ' dry=' + e.data.dry.toFixed(4) + ' V4Bin=' + e.data.v4bIn.toFixed(4));
      }
    };

    _epw_initialized = true;

    // Send initial parameters (also handles routing)
    _epwSendParams();

    // --- Load FDTD attack tables (Phase 5: progressive enhancement) ---
    // Non-blocking: if fetch fails, pure modal synthesis continues.
    _epwLoadFDTDTables();
  });
  return _epw_initPromise;
}

function _epwLoadFDTDTables() {
  if (!_epw_node) return;
  // Phase 3.0.f: FDTD assets relocated to audio-core/assets/fdtd/.
  // Use AUDIO_CORE_BASE for embedded host override capability.
  var _coreBase = (typeof window !== 'undefined' && window.AUDIO_CORE_BASE) || 'audio-core/';
  var basePath = _coreBase + 'assets/fdtd/';
  Promise.all([
    fetch(basePath + 'attack_tables.bin?v=' + (window.APP_VERSION || Date.now())).then(function(r) {
      if (!r.ok) throw new Error('FDTD tables not found');
      return r.arrayBuffer();
    }),
    fetch(basePath + 'manifest.json?v=' + (window.APP_VERSION || Date.now())).then(function(r) {
      return r.json();
    })
  ]).then(function(results) {
    var attackData = results[0];
    var manifest = results[1];
    console.log('[EP-Engine] FDTD tables fetched: ' + (attackData.byteLength / 1e6).toFixed(1) + 'MB');
    // Transfer to worklet (zero-copy via Transferable)
    _epw_node.port.postMessage({
      type: 'fdtdTables',
      attackData: attackData,
      manifest: manifest
    }, [attackData]);
  }).catch(function(err) {
    console.log('[EP-Engine] FDTD tables not available (pure modal): ' + err.message);
  });
}

// ========================================
// PARAMETER UPDATES
// ========================================

// Voicing Lab (keys 検証ツール、2026-04-22) — Phase 1 Si 2N3392 voicing 値を
// worklet に送る。main thread の window.EpVoicingLab 経由で Voicing Lab UI から
// 変更される。undefined 時は worklet 側のデフォルト (constructor 値) が維持される。
function _epwSendVoicingLabParams(params) {
  if (!_epw_node) return;
  var msg = { type: 'params' };
  if (params && typeof params.gePreampDrive === 'number') msg.gePreampDrive = params.gePreampDrive;
  if (params && typeof params.gePreampGain === 'number') msg.gePreampGain = params.gePreampGain;
  if (params && typeof params.suitcasePreFxTrim === 'number') msg.suitcasePreFxTrim = params.suitcasePreFxTrim;
  if (params && typeof params.jaWetMix === 'number') msg.jaWetMix = params.jaWetMix;
  _epw_node.port.postMessage(msg);
}
// Global exposure for Voicing Lab UI (keys 専用、Plugin 切り出し時は外す)
if (typeof window !== 'undefined') {
  window._epwSendVoicingLabParams = _epwSendVoicingLabParams;
}

function _epwSendParams() {
  if (!_epw_node) return;
  // EpState is SSOT (set by audio.js UI + saved preferences). Read directly — no EpwState copy.
  var preset = EP_AMP_PRESETS[EpState.preset] || EP_AMP_PRESETS['Rhodes DI'];
  function stateOrPreset(key, fallback) {
    if (typeof EpState[key] === 'number' && EpState[key] !== fallback) return EpState[key];
    if (preset && typeof preset[key] === 'number') return preset[key];
    if (typeof EpState[key] === 'number') return EpState[key];
    return fallback;
  }
  // Voicing Lab 現在値 (window.EpVoicingLab、未設定なら worklet 側デフォルトを維持)
  var vl = (typeof window !== 'undefined' && window.EpVoicingLab) ? window.EpVoicingLab : null;
  var params = {
    type: 'params',
    pickupSymmetry: EpState.pickupSymmetry,
    pickupDistance: EpState.pickupDistance,
    pickupBassDriveBoost: stateOrPreset('pickupBassDriveBoost', 1.5),
    pickupBassBoost: stateOrPreset('pickupBassBoost', 1.5),
    pickupBassMinRatio: stateOrPreset('pickupBassMinRatio', 0.75),
    pickupMinRatio: stateOrPreset('pickupMinRatio', 0.7),
    gapVoicing: (typeof EpState.gapVoicing !== 'undefined') ? EpState.gapVoicing : 'dyno',
    fNewEnabled: (typeof EpState.fNewEnabled !== 'undefined') ? EpState.fNewEnabled : true,
    puPosBassDriveEnabled: (typeof EpState.puPosBassDriveEnabled !== 'undefined') ? EpState.puPosBassDriveEnabled : true,
    preampGain: EpState.preampGain,
    tsBass: EpState.tonestackBass,
    tsMid: EpState.tonestackMid,
    tsTreble: EpState.tonestackTreble,
    brightSwitch: EpState.brightSwitch,
    // powerampDrive removed 2026-04-13 (Phase 0.3c) — Twin-only param.
    volumePot: 0.5,
    springReverbMix: EpState.springReverbMix,
    springDwell: EpState.springDwell,
    use2ndPreamp: preset.preampType === '12AX7' && EpState.use2ndPreamp,
    useTonestack: !!preset.useTonestack,
    useCabinet: !!preset.useCabinet,
    ampType: preset.powerampType === 'GeTr' ? 'suitcase' : 'di',
    useSpringReverb: !!preset.useSpringReverb,
    springPlacement: preset.springPlacement || (preset.powerampType === '6L6' ? 'post_tremolo' : 'pre_tremolo'),
    springInputTrim: preset.springInputTrim !== undefined ? preset.springInputTrim : 1.0,
    springReturnGain: preset.springReturnGain !== undefined ? preset.springReturnGain : 1.0,
    springDriveMix: preset.springDriveMix !== undefined ? preset.springDriveMix : 1.0,
    springExciterMix: preset.springExciterMix !== undefined ? preset.springExciterMix : 1.0,
    springCoreMode: preset.springCoreMode || (preset.springCoreLinear ? 'linear' : 'full'),
    springDiagMuteNoteOff: !!preset.springDiagMuteNoteOff,
    springCoreLinear: !!preset.springCoreLinear,
    springSendHPFHz: preset.springSendHPFHz !== undefined ? preset.springSendHPFHz : 318,
    springTiltDb: preset.springTiltDb !== undefined ? preset.springTiltDb : -6,
    springSendLPFHz: preset.springSendLPFHz !== undefined ? preset.springSendLPFHz : 5000,
    springOutHPFHz: preset.springOutHPFHz !== undefined ? preset.springOutHPFHz : 530,
    springResonatorMix: preset.springResonatorMix !== undefined ? preset.springResonatorMix : 1.0,
    springModDepth: preset.springModDepth !== undefined ? preset.springModDepth : 8.0,
    springHfMix: preset.springHfMix !== undefined ? preset.springHfMix : 0.0010,
    springFeedbackScale: EpState.springFeedbackScale !== undefined ? EpState.springFeedbackScale : (preset.springFeedbackScale !== undefined ? preset.springFeedbackScale : 1.0),
    springStereoEnabled: EpState.springStereoEnabled !== false, // default true
    preampType: preset.preampType || null,
    pickupType: preset.pickupType || 'rhodes',
    puModel: EpwState.puModel || 'cylinder',
    whirlEnabled: EpwState.whirlEnabled !== false,
    beamDecayR: EpState.beamDecayR || 1.0,
    attackNoise: EpState.attackNoise !== undefined ? EpState.attackNoise : 0.5,
    releaseNoise: EpState.releaseNoise !== undefined ? EpState.releaseNoise : (EpState.attackNoise !== undefined ? EpState.attackNoise : 0.5),
    releaseRing: EpState.releaseRing !== undefined ? EpState.releaseRing : (EpState.attackNoise !== undefined ? EpState.attackNoise : 0.5),
    tineRadiation: EpState.tineRadiation !== undefined ? EpState.tineRadiation : 0,
    rhodesLevel: EpState.rhodesLevel !== undefined ? EpState.rhodesLevel : 1.0,
    // Twin AB763 stage gains (v1aGain/v2bGain/v4bGain/powerGain) and
    // Jensen cabinet filter freqs (cabHPFFreq/cabPeakFreq/cabLPFFreq) removed
    // 2026-04-13 (Phase 0.3c) — no longer applied anywhere in the worklet.
    cabinetGain: EpState.cabinetGain,
    tremoloOn: EpState.tremoloOn || false,
    tremoloFreq: EpState.tremoloFreq || 4.5,
    tremoloDepth: EpState.tremoloDepth || 0,
  };
  // Voicing Lab 現在値があれば載せる (undefined だと worklet 側チェックで skip)
  if (vl) {
    if (typeof vl.gePreampDrive === 'number') params.gePreampDrive = vl.gePreampDrive;
    if (typeof vl.gePreampGain === 'number') params.gePreampGain = vl.gePreampGain;
    if (typeof vl.suitcasePreFxTrim === 'number') params.suitcasePreFxTrim = vl.suitcasePreFxTrim;
    if (typeof vl.jaWetMix === 'number') params.jaWetMix = vl.jaWetMix;
  }
  _epw_node.port.postMessage(params);
  // V4B/poweramp/cabinet now in worklet — no main-thread routing needed
}

function epianoWorkletUpdateParams(params) {
  // Merge amp chain params into EpState (SSOT) before sending.
  // The Twin amp chain dev sliders (v1aGain/v2bGain/v4bGain/powerGain/
  // powerampDrive/cabHPFFreq/cabPeakFreq/cabLPFFreq) were removed in
  // Phase 0.3c, leaving only cabinetGain on the Suitcase amp path.
  if (params && params.cabinetGain !== undefined) EpState.cabinetGain = params.cabinetGain;
  _epwSendParams();
}

// ========================================
// NOTE ON / OFF
// ========================================

function epianoWorkletNoteOn(ctx, midi, velocity, masterDest, outputGain) {
  if (!_epw_initialized) {
    epianoWorkletInit(ctx, masterDest).then(function() {
      epianoWorkletNoteOn(ctx, midi, velocity, masterDest, outputGain);
    });
    return { cancel: function() {} };
  }

  // Sync all params from EpState (SSOT) on every noteOn.
  // EpState is updated by audio.js UI + saved preferences.
  _epwSendParams();

  _epw_node.port.postMessage({
    type: 'noteOn',
    midi: midi,
    velocity: velocity,
    outputGain: (outputGain !== undefined) ? outputGain : 1.0,
  });

  // Return cancel function (for noteOff / damper)
  var _cancelled = false;
  return {
    cancel: function() {
      if (_cancelled) return;
      _cancelled = true;
      if (_epw_node) {
        _epw_node.port.postMessage({ type: 'noteOff', midi: midi });
      }
    },
  };
}

function epianoWorkletNoteOff(midi) {
  if (_epw_node) {
    _epw_node.port.postMessage({ type: 'noteOff', midi: midi });
  }
}

function epianoWorkletAllNotesOff() {
  if (_epw_node) {
    _epw_node.port.postMessage({ type: 'allNotesOff' });
  }
}

function epianoWorkletSetSustain(on) {
  if (_epw_node) {
    _epw_node.port.postMessage({ type: 'sustain', on: !!on });
  }
}
