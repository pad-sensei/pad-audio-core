// ========================================
// E-PIANO PHYSICAL MODELING ENGINE
// ========================================
// Modal synthesis (tine) + nonlinear chain (pickup → preamp → tonestack → poweramp → cabinet)
// Design: urinami-san — "tines are near-pure sine waves; harmonics come from pickup and amp saturation"

// --- LUT size ---
var EP_LUT_SIZE = 1024;

// --- Shared resources (initialized once) ---
var _epCabinetNode = null;      // ConvolverNode: shared cabinet IR
var _epCabinetGain = null;      // GainNode: cabinet output level
var _epSpringReverb = null;     // ConvolverNode or AudioWorkletNode: spring reverb (Accutronics 4AB3C1B)
var _epSpringReverbWorklet = false; // true when AudioWorklet spring reverb is active
var _epInitialized = false;
var _epRealIRLoaded = false;    // true when real Twin Reverb IR is loaded

// --- AB763 shared signal chain (correct Fender reverb routing) ---
// Per-voice V2B → _epDryBus ─────────────────────────────────────┐
// Per-voice tonestack → _epSendHPF → V3 → spring → V4A → pot ───┤→ _epV4B → poweramp → cabinet
var _epDryBus = null;           // GainNode: per-voice V2B outputs sum here
var _epSendHPF = null;          // BiquadFilter: HPF 318Hz on reverb send (500pF/1MΩ RC)
var _epV3Driver = null;         // WaveShaper: 12AT7 reverb driver (parallel triodes)
var _epV3Drive = null;          // GainNode: V3 send drive level (Dwell control)
var _epV3LUT = null;            // Float32Array: 12AT7 driver LUT
var _epV4AGain = null;          // GainNode: reverb recovery amp (~36dB, essentially linear)
var _epReverbPot = null;        // GainNode: reverb return level control
var _epV4B = null;              // WaveShaper: post-mix 12AX7 stage ("bloom")
var _epV4BMakeup = null;        // GainNode: V4B output level
var _epPowerDrive = null;       // GainNode: shared poweramp drive control
var _epSharedPoweramp = null;   // WaveShaper: shared 6L6 poweramp
var _epSharedPowerMakeup = null;// GainNode: poweramp output level
var _epHarpLPF = null;          // BiquadFilter: harp wiring LPF (5.7kHz, cable+Volume pot)

// --- Current LUTs (Float32Array, recomputed on param change) ---
var _epPickupLUT = null;
var _epPreampLUT = null;
var _epPowerampLUT = null;

// --- Current tonestack IIR coefficients ---
var _epTonestackFF = null;  // feedforward (b coefficients)
var _epTonestackFB = null;  // feedback (a coefficients)

// --- E-Piano parameters (UI-controllable) ---
var EpState = {
  pickupSymmetry: 0.3,    // 0..1: voicing (0=on-axis: 2nd harmonic dominant, 1=far off-axis: fundamental dominant)
  pickupDistance: 0.5,     // 0.1..1.0: horizontal gap (closer=more distortion)
  pickupBassDriveBoost: 1.5,
  pickupBassBoost: 1.5,
  pickupBassMinRatio: 0.75,
  pickupMinRatio: 0.7,
  gapVoicing: 'dyno',      // 'factory' | 'dyno' (D-3 A/B)、worklet 側にも伝播。実際の curve は worklet-processor.js の puGapMm(). fallback engine 側 `_puGapMm` は現状 factory curve 固定 (Codex P2 指摘、将来同期)
  preampGain: 1.0,         // 0.5..5.0: input drive
  tonestackBass: 0.5,      // 0..1
  tonestackMid: 0.5,       // 0..1
  tonestackTreble: 0.5,    // 0..1
  powerampDrive: 1.0,      // 0.5..3.0
  preset: 'Rhodes DI',  // DI default. Amp chain (Stage+Twin) is WIP — gain staging needs recalibration.
  // Tine/tonebar/beam mode amplitudes are determined by physics, not user knobs.
  // Year/model variation → presets (Mark I '73, Mark II, Suitcase, etc.)
  // Individual key variation → per-key hash table (_epKeyVariation)
  use2ndPreamp: true,      // AB763 V2A+V2B (cathode follower + 2nd gain stage)
  brightSwitch: false,     // AB763 bright cap bypass (increases C1 → more treble)
  reverbType: 'spring',    // 'spring' | 'plate'
  springReverbMix: 0.12,   // Spring reverb wet level (Fender "2-3" ≈ 0.08-0.15) — AMOUNT knob
  springDwell: 6.0,        // Spring reverb send drive (V3 driver gain, higher = more saturation)
  springFeedbackScale: 0.9, // Spring feedback loop gain → T60 (0.3-0.95) — DECAY knob
  springStereoEnabled: true, // Spring tank L/R decorrelation toggle (tank0→L, tank1→R)
  attackNoise: 0,           // Mechanical noise (single knob: attack + release). Default 0.
};

// ========================================
// AMP MODEL PRESETS
// ========================================
// 'Rhodes Stage + Twin' preset was removed on 2026-04-13 (Phase 0.3b).
// It was a repeating source of routing bugs and is no longer reachable
// from the UI. The preset definition is preserved in
// experimental/twin-amp-preset.md for future reference; the DSP branch
// inside epiano-worklet-processor.js is dead code that will be deleted
// in Phase 0.3c.
// outputGainDb: preset 間の音量揃え (urinami 2026-04-22 方針)。
// DAW の他プラグインと並べた時、マスター VOL=5/10 で同じような平均音量に
// なることを目標に、preset ごとの素の出力レベル差を dB 補正で埋める。
// 基準: DI (アンプ無し)。Suitcase は内蔵アンプで音量が上がるので dB を下げる。
// 物理モデルの内部挙動は変えず、最終段の gain staging のみ補正する。
// D-8 (2026-04-25): Suitcase を Clean / Drive / Vintage の 3 variant に分割。
// 従来の 'Rhodes Suitcase' は Drive に相当 (2026-04-24 までの bark/drive 寄り
// calibration)。Clean は HPS 会員 default 向け、Vintage は warm/saturated 趣味向け。
// 共通部分 (preamp/poweramp type、spring 系、outputGainDb) は factor out。
var _SUITCASE_COMMON = {
  pickupType: 'rhodes',
  // 2026-04-22 Phase 1: Peterson 80W Preamp (fig11-8 Q1/Q2 = 2N3392 Si NPN 2-stage)
  preampType: 'Si2N3392_2stage',
  powerampType: 'GeTr',
  useTonestack: true,
  useCabinet: true,
  useSpringReverb: true,
  springPlacement: 'pre_tremolo',
  springInputTrim: 0.34,
  springReturnGain: 0.85,
  springSendHPFHz: 180,
  springTiltDb: -3,
  springSendLPFHz: 5800,
  springOutHPFHz: 260,
  springResonatorMix: 0.45,
  springModDepth: 4.0,
  springHfMix: 0.0005,
  springFeedbackScale: 0.88,
  // outputGainDb 履歴: 0 → 3 (D-5 perceptual) → 6 (D-5.1) → 9 (D-5.2 両 preset +3)
  outputGainDb: 9,
};

var EP_AMP_PRESETS = {
  'Rhodes Suitcase Clean': Object.assign({}, _SUITCASE_COMMON, {
    // Clean: HPS 会員 default 向け、素直な Rhodes 音。drive 最小、makeup 控えめ。
    voicingLabDefaults: { gePreampDrive: 3.5546, gePreampGain: 1.62, suitcasePreFxTrim: 0.19, jaWetMix: 0.0222 },
    pickupBassDriveBoost: 1.0124,
    pickupBassBoost: 0.6080,
    pickupBassMinRatio: 0.8719,
    pickupMinRatio: 0.70,
  }),
  'Rhodes Suitcase Drive': Object.assign({}, _SUITCASE_COMMON, {
    // Drive: 70年代 records 定番、bark/fat 前面。従来の 'Rhodes Suitcase' 相当。
    voicingLabDefaults: { gePreampDrive: 3.3010, gePreampGain: 2.5, suitcasePreFxTrim: 0.5745, jaWetMix: 0.1753 },
    pickupBassDriveBoost: 1.8751,
    pickupBassBoost: 1.3560,
    pickupBassMinRatio: 0.6501,
    pickupMinRatio: 0.95,
  }),
  'Rhodes Suitcase Vintage': Object.assign({}, _SUITCASE_COMMON, {
    // Vintage: 経年 germanium、J-A saturation 強め、warm/mid 押し出し。
    voicingLabDefaults: { gePreampDrive: 1.1038, gePreampGain: 2.5, suitcasePreFxTrim: 1.0, jaWetMix: 0.4023 },
    pickupBassDriveBoost: 1.0453,
    pickupBassBoost: 1.9521,
    pickupBassMinRatio: 0.9024,
    pickupMinRatio: 0.8415,
  }),
  'Rhodes Suitcase Vintage Envelope Filter': Object.assign({}, _SUITCASE_COMMON, {
    // 2026-04-27 urinami: AMP Vintage に Envelope Filter variant (Wah ではなく
    // Envelope Filter が正確、画像 #17 で確認)。voicing は Vintage 流用、
    // Envelope Filter 効果は host 側 (64PE autoFilter BP) で実装。urinami 後で
    // 実機 voicing 確定 → 値固め直し予定。useCabinet (HPS gate) は
    // _SUITCASE_COMMON 由来。
    voicingLabDefaults: { gePreampDrive: 1.1038, gePreampGain: 2.5, suitcasePreFxTrim: 1.0, jaWetMix: 0.4023 },
    pickupBassDriveBoost: 1.0453,
    pickupBassBoost: 1.9521,
    pickupBassMinRatio: 0.9024,
    pickupMinRatio: 0.8415,
  }),
  // Backward compat: localStorage に 'Rhodes Suitcase' が残っている場合
  // audio-persistence.js の migration で 'Rhodes Suitcase Drive' に置換する。
  // 定義自体は削除 (エイリアスなし、migrate-and-forget)。
  // 'Wurlitzer 200A' preset was removed on 2026-04-13 (Phase 0.3c) —
  // never exposed in the user-facing ENGINES registry, and its only
  // worklet path used the now-deleted Twin DSP. Definition preserved
  // in experimental/wurlitzer-preset.md.
  'Rhodes DI': {
    pickupType: 'rhodes',
    preampType: null,
    powerampType: null,
    useTonestack: false,
    useCabinet: false,
    useSpringReverb: true,
    springPlacement: 'pre_tremolo',
    springInputTrim: 0.06,
    springReturnGain: 1.0,
    springDriveMix: 0.0,
    springExciterMix: 0.0,
    springCoreMode: 'full',
    springSendHPFHz: 120,
    springTiltDb: -1.5,
    springSendLPFHz: 6800,
    springOutHPFHz: 150,
    springResonatorMix: 0.06,
    springModDepth: 0.0,
    springHfMix: 0.0,
    springFeedbackScale: 0.9,
    pickupBassDriveBoost: 1.0066,
    pickupBassBoost: 1.3091,
    pickupBassMinRatio: 0.95,
    pickupMinRatio: 0.70,
    // DI は PU 直接出力。+12dB はクリップ、+6dB は Suitcase と並べて適正。
    // 2026-04-22 第3次: urinami「クリップする所がある」→ +12 → +6 に下げ。
    // 2026-04-25 D-5.2: urinami「2つとも あと 3 dB 上げて」→ +6 → +9 dB
    //   (Suitcase と同調上げで Stage/Suitcase 相対バランス維持)
    outputGainDb: 9,
  },
};

// ========================================
// LUT COMPUTATION FUNCTIONS
// ========================================

// --- PU LUT computation (Falaize & Hélie 2017 eq 25-27) ---
// gapScale: per-register PU gap adjustment (1.0 = mid-range reference gap)
//   Bass/treble: gap is 2× wider → gapScale=2.0 → gentler, lower sensitivity
//   Mid: gap is reference → gapScale=1.0 → steeper, higher sensitivity
// qRange: physical displacement range mapped to WaveShaper [-1,+1]
//   Bass: large tine displacement → wide qRange → LUT covers full PU sweep
//   Treble: tiny displacement → narrow qRange → LUT zooms into linear center
function computePickupLUT_Rhodes(symmetry, distance, gapScale, qRange) {
  var lut = new Float32Array(EP_LUT_SIZE);
  // Rhodes PU: electromagnetic pickup — Falaize & Hélie 2017 (IRCAM) equations (25-27)
  // Port-Hamiltonian model: magnet (sphere) + coil + ferrous tine
  //
  // g(q) = [1/f1(q) - 2*Lhor²/f1²(q)] - [1/f2(q) - 2*Lhor²/f2²(q)]
  // f1(q) = (q - Rp + Lver)² + Lhor²
  // f2(q) = (q + Rp + Lver)² + Lhor²
  //
  // Lver = vertical offset (voicing) — Rhodes tech adjusts this with PU screw
  // Lhor = horizontal gap — closer = stronger nonlinearity = more harmonics
  // Rp = coil radius (~3mm physical, normalized)
  //
  // Refs: Falaize & Hélie JSV 2017 eq(25-27), Shear 2011 (UCSB) Fig2.3/2.5

  var sym = Math.max(0, Math.min(1, symmetry));
  var Rp = 0.2;                        // coil radius (normalized, ~5mm physical)
  var Lver = sym * 0.25;               // 0=on-axis, 0.5=Rp×1.25 (far off-axis)
  var baseLhor = distance * 0.35 + 0.05;
  var gs = (gapScale !== undefined) ? gapScale : 1.0;
  var Lhor = baseLhor * gs;            // per-register gap adjustment

  var Lhor2 = Lhor * Lhor;

  // qRange: how much physical displacement [-1,+1] covers.
  // Default 1.0 = standard range (~25mm physical, matching Rp=0.2 normalization).
  // Bass: qRange > 1 → LUT covers wider displacement → tine sweeps past PU → pulsed waveform
  // Treble: qRange < 1 → LUT zooms into center → stays linear → bell
  var qr = (qRange !== undefined && qRange > 0) ? qRange : 1.0;

  for (var i = 0; i < EP_LUT_SIZE; i++) {
    var q = ((i / (EP_LUT_SIZE - 1)) * 2 - 1) * qr;

    var d1 = q - Rp + Lver;
    var f1 = d1 * d1 + Lhor2;

    var d2 = q + Rp + Lver;
    var f2 = d2 * d2 + Lhor2;

    var g1 = 1.0 / f1 - 2.0 * Lhor2 / (f1 * f1);
    var g2 = 1.0 / f2 - 2.0 * Lhor2 / (f2 * f2);
    lut[i] = g1 - g2;
  }

  // Remove DC offset at center
  var dcOffset = lut[Math.floor(EP_LUT_SIZE / 2)];
  for (var i = 0; i < EP_LUT_SIZE; i++) lut[i] -= dcOffset;

  // Normalize: all LUTs share the same reference so physical sensitivity is preserved.
  // Closer PU (smaller gapScale) → steeper curve → higher peak → louder + more nonlinear.
  // Wider PU (larger gapScale) → gentler curve → lower peak → quieter + more linear.
  var refLhor = 0.25;
  var refLhor2 = refLhor * refLhor;
  var refD1 = 0 - Rp + 0.15;
  var refF1 = refD1 * refD1 + refLhor2;
  var refD2 = 0 + Rp + 0.15;
  var refF2 = refD2 * refD2 + refLhor2;
  var refG1 = 1.0 / refF1 - 2.0 * refLhor2 / (refF1 * refF1);
  var refG2 = 1.0 / refF2 - 2.0 * refLhor2 / (refF2 * refF2);
  var refPeak = Math.abs(refG1 - refG2);
  var maxVal = 0;
  for (var i = 0; i < EP_LUT_SIZE; i++) {
    if (Math.abs(lut[i]) > maxVal) maxVal = Math.abs(lut[i]);
  }
  if (maxVal > 0 && refPeak > 0) {
    var scale = 0.7 / refPeak;
    for (var i = 0; i < EP_LUT_SIZE; i++) {
      lut[i] *= scale;
      if (lut[i] > 0.95) lut[i] = 0.95;
      if (lut[i] < -0.95) lut[i] = -0.95;
    }
  }
  return lut;
}

function pickupVoicedDistance(baseDistance, midi, bassBoost, bassMinRatio, minRatio) {
  var base = Math.max(0.01, baseDistance || 0.5);
  var globalMin = Math.max(0.05, Math.min(1.0, minRatio !== undefined ? minRatio : 0.7));
  if (midi >= 48) return Math.max(base * globalMin, base);

  var lowBandScale = Math.max(0, Math.min(1, (48 - midi) / 20));
  var boost = Math.max(0, bassBoost !== undefined ? bassBoost : 1.5);
  var scale = 1.0 - (0.15 * boost * lowBandScale);
  var bassMin = Math.max(0.05, Math.min(1.0, bassMinRatio !== undefined ? bassMinRatio : 0.75));
  return Math.max(base * bassMin, base * scale);
}

function epPresetOrStateNumber(preset, key, fallback) {
  if (typeof EpState[key] === 'number' && EpState[key] !== fallback) return EpState[key];
  if (preset && typeof preset[key] === 'number') return preset[key];
  if (typeof EpState[key] === 'number') return EpState[key];
  return fallback;
}

function computePickupLUT_Wurlitzer(distance) {
  var lut = new Float32Array(EP_LUT_SIZE);
  var d0 = distance * 0.5 + 0.2; // base gap
  for (var i = 0; i < EP_LUT_SIZE; i++) {
    var x = (i / (EP_LUT_SIZE - 1)) * 2 - 1; // -1..1
    // Electrostatic: capacitance ∝ 1/(d0+x), clamp to avoid division by zero
    var displacement = x * 0.8; // scale to physical range
    lut[i] = 1.0 / (d0 + displacement) - 1.0 / d0; // zero-centered
  }
  // Normalize
  var maxVal = 0;
  for (var i = 0; i < EP_LUT_SIZE; i++) {
    if (Math.abs(lut[i]) > maxVal) maxVal = Math.abs(lut[i]);
  }
  if (maxVal > 0) {
    for (var i = 0; i < EP_LUT_SIZE; i++) lut[i] /= maxVal;
  }
  return lut;
}

function computePreampLUT_12AX7() {
  // Twin Reverb AB763 first preamp stage — Koren model with circuit operating point
  // Circuit: 12AX7 triode, Ra=100kΩ, Rk=1.5kΩ (bypassed), Vb+=330V
  // Operating point: Vgk_bias ≈ -1.5V, Vp ≈ 190V, Ip ≈ 1.4mA
  // Grid swing: ±3V max before grid conduction / cutoff
  // Refs: Koren tube model, fenderguru.com AB763 schematic
  var lut = new Float32Array(EP_LUT_SIZE);
  var mu = 100, ex = 1.4, kG1 = 1060, kP = 600, kVB = 300;
  // Circuit params
  var Vb = 330;       // B+ supply voltage
  var Ra = 100000;    // plate load resistor (100kΩ)
  var Vgk_bias = -1.5; // grid bias from cathode resistor
  var gridSwing = 3.0;  // max grid voltage swing (±3V)

  // First pass: compute raw plate voltages across input range
  var rawOut = new Float32Array(EP_LUT_SIZE);
  for (var i = 0; i < EP_LUT_SIZE; i++) {
    var x = (i / (EP_LUT_SIZE - 1)) * 2 - 1; // -1..1 input
    var Vgk = Vgk_bias + x * gridSwing;
    // Grid conduction clamp: grid can't go much above 0V
    if (Vgk > 0.3) Vgk = 0.3 + (Vgk - 0.3) * 0.05; // hard clip at grid conduction
    // Iterative load line: Vp = Vb - Ip*Ra, Ip = f(Vgk, Vp)
    // Use 3 Newton iterations for convergence
    var Vp = 190; // initial guess (operating point)
    for (var iter = 0; iter < 3; iter++) {
      var E1 = Math.log(1 + Math.exp(kP * (1/mu + Vgk / Math.sqrt(kVB + Vp*Vp)))) / kP;
      var Ip = Math.pow(Math.max(E1, 0), ex) / kG1;
      Vp = Vb - Ip * Ra;
      if (Vp < 0) Vp = 0; // plate can't go negative
    }
    rawOut[i] = Vp;
  }

  // Normalize: center at operating point, scale to -1..1
  var Vp_rest = rawOut[Math.floor(EP_LUT_SIZE / 2)];
  var maxSwing = 0;
  for (var i = 0; i < EP_LUT_SIZE; i++) {
    lut[i] = rawOut[i] - Vp_rest;
    if (Math.abs(lut[i]) > maxSwing) maxSwing = Math.abs(lut[i]);
  }
  // Invert: increasing grid voltage → decreasing plate voltage (common cathode)
  if (maxSwing > 0) {
    for (var i = 0; i < EP_LUT_SIZE; i++) lut[i] = -lut[i] / maxSwing;
  }

  return lut;
}

function computePreampLUT_NE5534() {
  // Op-amp: linear until rail, then hard clip with slight softening
  var lut = new Float32Array(EP_LUT_SIZE);
  var rail = 0.85;
  for (var i = 0; i < EP_LUT_SIZE; i++) {
    var x = (i / (EP_LUT_SIZE - 1)) * 2 - 1;
    if (Math.abs(x) < rail) {
      lut[i] = x;
    } else {
      var excess = (Math.abs(x) - rail) / (1 - rail);
      lut[i] = (x > 0 ? 1 : -1) * (rail + (1 - rail) * Math.tanh(excess * 3));
    }
  }
  return lut;
}

function computePreampLUT_BJT() {
  // Bipolar transistor: moderate soft clip
  var lut = new Float32Array(EP_LUT_SIZE);
  for (var i = 0; i < EP_LUT_SIZE; i++) {
    var x = (i / (EP_LUT_SIZE - 1)) * 2 - 1;
    // Asymmetric: NPN clips positive harder
    lut[i] = x >= 0
      ? Math.tanh(x * 2.0) * 0.9
      : Math.tanh(x * 1.5) * 1.05;
  }
  return lut;
}

function computePreampLUT_Si2N3392_2stage() {
  // Peterson 80W Suitcase Preamp (fig11-8 Q1, Q2 = selected 2N3392)
  // 2 段 Si NPN common-emitter カスケード。
  //
  // 物理根拠:
  //   - Si NPN の入出力特性は bias 点周辺で本質的に線形 (Vbe の自己 bias)。
  //   - positive swing (Vce → 0) は soft 飽和 (Vbe が fully-on) — 滑らかな knee。
  //   - negative swing (Vce → Vcc) は少し硬い knee (cutoff 領域へ)。
  //   - 2 段カスケード: 小振幅では両段とも線形 → 通過。大振幅で 1 段目が
  //     knee に入り、2 段目はそれを受けて更に圧縮。
  //
  // 関数形: y = x / (1 + |x|^n)^(1/n)  (smooth saturator)
  //   - 小信号では y ≈ x (高次項は n に依存して極小 → THD<-50dB 容易)
  //   - |x| = 1 で y = 1/2^(1/n) (n=2 なら 0.707, n=3 なら 0.794)
  //   - n が大きいほど線形領域が rail 近くまで伸び、knee が硬い (cutoff 型)
  //   - n が小さいほど早い段階で曲がり始め、knee が滑らか (saturation 型)
  //
  // LUT 表現は [-1,+1] 正規化。物理ゲインは preampGain / preampMakeup に委ねる。
  //
  // Ref: Peterson Stage conversion 80W Service Manual fig11-8 (Si NPN CE, 2 stage)
  //      永続ノート Peterson 80W Suitcase の Power Module は Si BJT push-pull
  var lut = new Float32Array(EP_LUT_SIZE);
  // n の意味 (smooth saturator y = x/(1+|x|^n)^(1/n)):
  //   大 n → 線形領域が長く伸び、knee は硬い (後で急に曲がる)
  //   小 n → 早い段階で曲がり始め、knee は滑らか
  //
  // 2N3392 CE (+25V rail 中点 bias) の output 方向と knee の対応:
  //   positive output (Vce → Vce_sat ≈ 0.2V、saturation 方向):
  //     → 飽和は緩やか (Vce_sat は Ic に連続依存) → SOFT knee → nPos=2
  //   negative output (Vce → Vcc、cutoff 方向):
  //     → Ic が 0 に達すると急停止 → HARD knee → nNeg=3
  //
  // 2 段カスケードで THD は x=0.014 (-40 dBFS) で -85 dB、x=0.45 (-10 dBFS) で
  // -27.9 dB を実測。Phase 1 完了条件を満たす。
  var nPos = 2;  // positive soft knee (Vce_sat saturation 方向)
  var nNeg = 3;  // negative hard knee  (cutoff 方向)

  function stage(x) {
    var n = x >= 0 ? nPos : nNeg;
    var ax = Math.abs(x);
    return x / Math.pow(1 + Math.pow(ax, n), 1 / n);
  }

  for (var i = 0; i < EP_LUT_SIZE; i++) {
    var x = (i / (EP_LUT_SIZE - 1)) * 2 - 1;
    lut[i] = stage(stage(x));
  }
  // 正規化はしない (worklet の normalizeLUTUnityGain は x=0 slope unity 化のみで、
  // 本 LUT は slope(0)=1 なので slope 再正規化では形状不変)。engine / worklet 間で
  // LUT 配列が同一数値になるようにして、L4 数値比較 test が成立する設計。
  return lut;
}

function computePowerampLUT_6L6() {
  // Push-pull Class AB: even harmonics cancel, crossover region
  var lut = new Float32Array(EP_LUT_SIZE);
  for (var i = 0; i < EP_LUT_SIZE; i++) {
    var x = (i / (EP_LUT_SIZE - 1)) * 2 - 1;
    var tubeA = Math.tanh(x * 1.5 + 0.05);  // slight bias offset
    var tubeB = Math.tanh(-x * 1.5 + 0.05);
    lut[i] = (tubeA - tubeB) * 0.5;
  }
  return lut;
}

function computePowerampLUT_GeTr() {
  // Germanium transistor: softer than silicon, warmer clipping
  var lut = new Float32Array(EP_LUT_SIZE);
  for (var i = 0; i < EP_LUT_SIZE; i++) {
    var x = (i / (EP_LUT_SIZE - 1)) * 2 - 1;
    // Cubic soft clipper (germanium-like rounded knee)
    if (Math.abs(x) < 0.667) {
      lut[i] = x - (x * x * x) / 3;
    } else {
      lut[i] = (x > 0 ? 1 : -1) * 0.667;
    }
  }
  return lut;
}

function computePowerampLUT_SS() {
  // Solid-state: quasi-complementary output, harder clip
  var lut = new Float32Array(EP_LUT_SIZE);
  for (var i = 0; i < EP_LUT_SIZE; i++) {
    var x = (i / (EP_LUT_SIZE - 1)) * 2 - 1;
    lut[i] = Math.tanh(x * 2.5) * 0.85;
  }
  return lut;
}

function computeV3DriverLUT_12AT7() {
  // 12AT7 reverb driver — Koren model, both triode sections paralleled
  // AB763: V3 drives reverb output transformer (Hammond 1750A, 22.8kΩ primary)
  // Why 12AT7: low rp (10.9kΩ vs 62.5kΩ) = better current drive into transformer
  // Parallel triodes: rp halved to ~5.5kΩ, gm doubled to ~11mA/V
  //
  // Operating point (measured): Vgk=-8.2V, Vp≈450V, Ip≈1.86mA/section
  // High headroom: grid swings ±10V before clipping vs 12AX7's ±3V
  // At normal Volume (3-5): essentially clean
  // At pushed Volume (7+): grid conduction = gritty reverb character
  //
  // Refs: Koren tube model, ampbooks.com reverb driver analysis,
  //       Rob Robinette AB763, fenderguru.com tube specs
  var lut = new Float32Array(EP_LUT_SIZE);
  var mu = 60, ex = 1.35, kG1 = 460, kP = 300, kVB = 300;
  var Vgk_bias = -8.2;
  var gridSwing = 10.0; // wider than 12AX7 — more headroom before clipping

  var rawOut = new Float32Array(EP_LUT_SIZE);
  for (var i = 0; i < EP_LUT_SIZE; i++) {
    var x = (i / (EP_LUT_SIZE - 1)) * 2 - 1;
    var Vgk = Vgk_bias + x * gridSwing;
    // Grid conduction: soft clamp above ~0V (grid can't go much positive)
    if (Vgk > 0.3) Vgk = 0.3 + (Vgk - 0.3) * 0.02;
    // Koren plate current model (transformer-coupled: Vp stays near B+)
    var Vp = 450;
    var E1 = Math.log(1 + Math.exp(kP * (1 / mu + Vgk / Math.sqrt(kVB + Vp * Vp)))) / kP;
    var Ip = Math.pow(Math.max(E1, 0), ex) / kG1;
    rawOut[i] = Ip * 2; // parallel sections double the current
  }
  // Center at operating point, normalize to -1..1
  var Ip_rest = rawOut[Math.floor(EP_LUT_SIZE / 2)];
  var maxSwing = 0;
  for (var i = 0; i < EP_LUT_SIZE; i++) {
    lut[i] = rawOut[i] - Ip_rest;
    if (Math.abs(lut[i]) > maxSwing) maxSwing = Math.abs(lut[i]);
  }
  if (maxSwing > 0) {
    for (var i = 0; i < EP_LUT_SIZE; i++) lut[i] /= maxSwing;
  }
  return lut;
}

// ========================================
// TONESTACK (Fender TMB — Hybrid Biquad + WaveShaper)
// ========================================
// Biquad chain for frequency shaping (calibrated to Yeh & Smith 2006 AB763 curve)
// + mild WaveShaper between stages for nonlinear interaction (carbon comp saturation)
// → "chime" quality that pure linear IIR cannot produce
//
// Signal flow: HPF(DC block) → LowShelf(bass) → WS(mild saturation) → Peaking(mid scoop) → HighShelf(treble)
//
// Why not IIR: IIRFilterNode retains internal state after input drops → ringing artifacts
// amplified by downstream gain stages. BiquadFilterNode doesn't have this problem.
// Why WaveShaper: real passive tonestack has micro-nonlinearities from carbon comp resistors
// and capacitor dielectric absorption. These create subtle intermodulation that contributes
// to the "alive" quality of tube amps.

var _epTonestackSatLUT = null;

function _initTonestackSatLUT() {
  if (_epTonestackSatLUT) return;
  // Very mild saturation: models carbon composition resistor nonlinearity
  // At low signal: nearly linear. At peaks: gentle 2nd harmonic generation.
  var size = 256;
  _epTonestackSatLUT = new Float32Array(size);
  for (var i = 0; i < size; i++) {
    var x = (i / (size - 1)) * 2 - 1; // -1..1
    // Soft asymmetric saturation: slight 2nd harmonic bias
    // tanh(1.2x) + 0.05*x² gives ~1% 2nd harmonic at full scale
    _epTonestackSatLUT[i] = Math.tanh(1.2 * x) + 0.05 * x * Math.abs(x);
  }
  // Normalize so peak output = 1.0
  var peak = 0;
  for (var i = 0; i < size; i++) {
    if (Math.abs(_epTonestackSatLUT[i]) > peak) peak = Math.abs(_epTonestackSatLUT[i]);
  }
  if (peak > 0) {
    for (var i = 0; i < size; i++) _epTonestackSatLUT[i] /= peak;
  }
}

function computeTonestackParams(bass, mid, treble, bright) {
  // Returns Biquad parameters calibrated to AB763 Yeh & Smith curve:
  //   50Hz: +1dB, 100Hz: -1dB, 400Hz: -10dB, 600Hz: -11dB (scoop),
  //   1kHz: -9dB, 3kHz: -2dB, 8kHz: 0dB
  //
  // Knob ranges derived from Yeh & Smith coefficient sweep:
  //   Bass 0→1:  100Hz varies -16dB to 0dB (16dB range)
  //   Mid 0→1:   600Hz varies -20dB to -3dB (17dB range)
  //   Treble 0→1: 3kHz varies -14dB to 0dB (14dB range)

  // Clamp
  var b = Math.max(0, Math.min(1, bass));
  var m = Math.max(0, Math.min(1, mid));
  var t = Math.max(0, Math.min(1, treble));

  return {
    // DC blocking highpass (passive network has zero DC pass-through)
    hpf: { type: 'highpass', frequency: 30, Q: 0.707 },

    // Low shelf: bass control. Fender bass pot range ≈ 16 dB.
    // Center frequency 100Hz (AB763 bass cap + pot interaction)
    lowShelf: {
      type: 'lowshelf',
      frequency: 100,
      gain: -16 + b * 16  // -16 to 0 dB
    },

    // Mid scoop: peaking EQ. THE Fender TMB signature.
    // AB763 fixed 6.8K = deep scoop. Mid knob controls depth.
    // Q calibrated to match Yeh & Smith: scoop spans ~200Hz-2kHz
    midScoop: {
      type: 'peaking',
      frequency: 600,
      Q: 0.8,
      gain: -17 + m * 14  // -17 to -3 dB (always some scoop — Fender character)
    },

    // High shelf: treble control. Bright switch shifts the knee lower.
    // AB763 treble cap 250pF → bright bypass multiplies C1 → lower frequency
    highShelf: {
      type: 'highshelf',
      frequency: bright ? 1500 : 3000,
      gain: -14 + t * 14   // -14 to 0 dB
    }
  };
}

// ========================================
// RHODES 88-KEY PHYSICAL DATA TABLES
// ========================================
// Sources: Shear 2011 (UCSB), Rhodes Service Manual, EP-Forum

// --- Q-value table (Shear 2011, 1974 Mark I, Tables 2.1 + 5.1) ---
var _EP_Q_TABLE = [
  [39,949],[51,731],[59,1101],[60,1238],[61,1040],
  [62,1156],[64,1520],[75,2175],[87,1761],
];

function _interpolateQ(midi) {
  var t = _EP_Q_TABLE;
  if (midi <= t[0][0]) return t[0][1];
  if (midi >= t[t.length - 1][0]) return t[t.length - 1][1];
  for (var i = 0; i < t.length - 1; i++) {
    if (midi >= t[i][0] && midi <= t[i + 1][0]) {
      var frac = (midi - t[i][0]) / (t[i + 1][0] - t[i][0]);
      return t[i][1] + frac * (t[i + 1][1] - t[i][1]);
    }
  }
  return 1200;
}

// --- Hammer contact time (Rhodes Service Manual + Hertz contact model) ---
// Contact time determines excitation spectrum: fc = 1/(π×Tc)
// Shorter contact → higher fc → more beam mode excitation
// Sources: Chaigne & Askenfelt 1994, Rhodes Service Manual (Shore A values)
// Returns { Tc: contact time, relMass: relative mass (Shore 70 = 1.0) }
function _getHammerParams(midi, velocity) {
  var key = midi - 20;
  // Contact time from hammer tip material (at moderate velocity)
  // Mass: height × density (same diameter). Shore 70 = reference.
  // Wood tip: maple core (ρ≈0.7) in neoprene tube. Lighter than full neoprene.
  var Tc0, relMass;
  if (key <= 30)      { Tc0 = 0.0035; relMass = 0.67; } // Shore 30: 6.35mm × 1.3
  else if (key <= 40) { Tc0 = 0.0025; relMass = 0.83; } // Shore 50: 7.94mm × 1.3
  else if (key <= 50) { Tc0 = 0.0017; relMass = 1.00; } // Shore 70: 9.53mm × 1.3 (ref)
  else if (key <= 64) { Tc0 = 0.0012; relMass = 1.17; } // Shore 90: 11.11mm × 1.3
  else                { Tc0 = 0.00015; relMass = 0.67; } // Wood: 11.11mm × 0.75
  // Velocity shortens contact: Hertz model Tc ∝ v^(-1/(p+1)), p≈2.5 → v^(-0.286)
  var Tc = Tc0 * Math.pow(Math.max(velocity, 0.1), -0.286);
  return { Tc: Tc, relMass: relMass };
}

// --- Tine length (exponential fit to Shear 2011 endpoints: 157mm at key 1, 18mm at key 88) ---
// Rhodes 88-key Mark I tine cutting chart. Calibrated to measured endpoints.
function _tineLength(midi) {
  var key = Math.max(1, Math.min(88, midi - 20)); // MIDI 21=key1(A0), MIDI 108=key88(A7)
  return 157 * Math.exp(-0.0249 * (key - 1)); // mm
}

// --- Striking line position (Service Manual: low=57.15mm, high=3.175mm from harp support) ---
// "Lower notes have a contact location closer to the center of the tine and higher notes
// closer to the base" (Sonderboe 2024 §3.3). Linear interpolation in key space.
function _strikingLine(midi) {
  var key = Math.max(1, Math.min(88, midi - 20));
  var t = (key - 1) / 87;
  return 57.15 * (1 - t) + 3.175 * t; // mm
}

// --- PU gap per register (Service Manual Ch.4) ---
// Rhodes tech adjusts PU height per register. Wider gap for bass = compensate for large tine displacement.
// Low (keys 1-30): 1/16" = 1.588mm
// Mid (keys 31-65): 1/32" = 0.794mm
// High (keys 65-88): 1/16" = 1.588mm (wood hammer tips, short tines)
function _puGapMm(midi) {
  var key = Math.max(1, Math.min(88, midi - 20));
  if (key <= 30) return 1.588;
  if (key <= 65) return 0.794;
  return 1.588;
}

// --- Euler-Bernoulli cantilever mode shapes ---
// φₙ(ξ) = cosh(βₙξ) - cos(βₙξ) - σₙ(sinh(βₙξ) - sin(βₙξ))
// βₙL eigenvalues and σₙ coefficients for first 3 modes
var _EP_BETAL = [1.8751, 4.6941, 7.8548];
var _EP_SIGMA = [0.7341, 1.0185, 0.9992];
// Pre-computed tip values φₙ(1.0) for normalization
var _EP_PHI_TIP = null;

function _cantileverPhi(xi, modeIdx) {
  var bx = _EP_BETAL[modeIdx] * xi;
  return Math.cosh(bx) - Math.cos(bx) - _EP_SIGMA[modeIdx] * (Math.sinh(bx) - Math.sin(bx));
}

// Normalized mode excitation: 0 at root, 1 at tip
function _modeExcitation(xi, modeIdx) {
  if (!_EP_PHI_TIP) {
    _EP_PHI_TIP = [_cantileverPhi(1.0, 0), _cantileverPhi(1.0, 1), _cantileverPhi(1.0, 2)];
  }
  return _cantileverPhi(xi, modeIdx) / _EP_PHI_TIP[modeIdx];
}

// --- Physical tip displacement factor (relative to reference key B3/MIDI 59) ---
// Tip displacement ∝ √(hammerMass) × L^(3/2) × φ₁(x_s/L)
// This replaces the ad-hoc pitchPUScale.
var _EP_TIP_REF = null; // cached reference value

function _tipDisplacementFactor(midi) {
  var L = _tineLength(midi);
  var xs = _strikingLine(midi);
  var xi = Math.min(xs / L, 0.95); // clamp (can't hit past the tip)
  var phi = _modeExcitation(xi, 0);
  var hammer = _getHammerParams(midi, 0.5);
  var massScale = Math.sqrt(hammer.relMass);

  if (!_EP_TIP_REF) {
    var Lr = _tineLength(59);
    var xsr = _strikingLine(59);
    var xir = Math.min(xsr / Lr, 0.95);
    var phir = _modeExcitation(xir, 0);
    var hr = _getHammerParams(59, 0.5);
    _EP_TIP_REF = Math.sqrt(hr.relMass) * Math.pow(Lr, 1.5) * phir;
  }
  return massScale * Math.pow(L, 1.5) * phi / _EP_TIP_REF;
}

// --- Tonebar presence and phase (Münster 2014, Service Manual) ---
// Münster Table 1: tonebars alternate in/anti phase depending on register.
// Anti-phase: tonebar cancels part of fundamental → thinner tone.
// In-phase: tonebar reinforces fundamental → fuller tone.
// Lowest 7 keys (midi ≤ 27): no tonebar at all.
function _hasTonebar(midi) { return midi > 27; }
function _tonebarPhase(midi) {
  // Münster 2014 measured 10 notes. Pattern: anti/anti/in/in/in/anti/anti/anti/in
  // Maps roughly to pitch classes, but actually depends on bar length vs tine.
  // Simplified: use chromatic note within octave (Eb=anti, F=in, G=in, etc.)
  // Low end (below ~F3, midi<53): predominantly anti-phase
  // Mid range (F3-B4, midi 53-71): predominantly in-phase
  // Upper mid (C5-A5, midi 72-81): anti-phase
  // High (B5+, midi 82+): in-phase
  if (midi <= 52) return -1;  // anti (Münster: Eb,Bb = anti)
  if (midi <= 71) return 1;   // in (Münster: F,C,G = in)
  if (midi <= 81) return -1;  // anti (Münster: D,A,E = anti)
  return 1;                   // in (Münster: B = in)
}

// ========================================
// PER-KEY VARIATION TABLE (Rhodes individuality)
// ========================================
// Real Rhodes pianos have per-key variation from manufacturing tolerances,
// aging, repair history, and tine/pickup alignment differences.
// "Perfect" parameters sound like a synth. Imperfection = warmth.
// Vintage Vibe parts are "too hi-fi" because they're too uniform.
// Seed-based pseudo-random: deterministic per key, different per key.

var _epKeyVariation = null;

function _initKeyVariation() {
  if (_epKeyVariation) return;
  _epKeyVariation = new Array(128);
  for (var k = 0; k < 128; k++) {
    var seed = k * 2654435761;
    var h = function(s) { s = ((s >>> 16) ^ s) * 0x45d9f3b; s = ((s >>> 16) ^ s) * 0x45d9f3b; return ((s >>> 16) ^ s) / 4294967296; };
    _epKeyVariation[k] = {
      lverOffset:    (h(seed)     - 0.5) * 0.06,
      lhorOffset:    (h(seed + 1) - 0.5) * 0.04,
      decayScale:    0.92 + h(seed + 3) * 0.16,
    };
  }
}

// ========================================
// MODE FREQUENCIES (Modal Synthesis)
// ========================================

function computeModeFrequencies(midiNote, velocity) {
  _initKeyVariation();
  var kv = _epKeyVariation[midiNote] || _epKeyVariation[60];

  var f0 = 440 * Math.pow(2, (midiNote - 69) / 12);
  velocity = velocity || 0.5;

  // --- Module 2: Resonator (per-key physical data) ---
  var Q = _interpolateQ(midiNote);
  var tau = Q / (Math.PI * f0);
  var decayVar = kv.decayScale;

  // --- Module 1: Excitation (hammer spectrum filter) ---
  // Hammer contact time → cutoff frequency → spectral filter on each mode.
  // Hammer mass → tine excitation energy (½mv²).
  // No arbitrary "woodBoost" or "velPow" — physics determines everything.
  // Ref: Chaigne & Askenfelt 1994, Hertz contact model
  var hammer = _getHammerParams(midiNote, velocity);
  var fc = 1 / (Math.PI * hammer.Tc); // hammer spectrum cutoff
  // Energy scaling: tine amplitude ∝ sqrt(½mv²) = sqrt(m) × v
  // Already in tineAmplitude via sqrt(velocity), so apply mass here.
  var massScale = Math.sqrt(hammer.relMass); // Wood(0.82) vs Shore90(1.08)

  var velDecayScale = 1.0 - velocity * 0.4;

  // --- Tonebar (Münster 2014: phase matters) ---
  var hasTB = _hasTonebar(midiNote);
  var tbPhase = hasTB ? _tonebarPhase(midiNote) : 0;
  var tonebarAmp = hasTB ? 0.3 * tbPhase : 0.0;
  // Tonebar is mechanically slaved to tine (Münster 2014: identical vibration frequency).
  // Same coupled system → same decay rate. Old 1.6× had no physical basis and caused
  // modulation artifacts (tonebar outlasting fundamental → changing harmonic balance).
  var tonebarDecay = hasTB ? tau : 0.001;

  // --- Striking line spatial excitation (Euler-Bernoulli mode shapes) ---
  // The hammer hits at position x_s along the tine (from clamped end).
  // Mode excitation ∝ φₙ(x_s/L): mode shape at the striking point.
  // Near the root (our range ξ=0.18-0.55), φₙ(ξ) ≈ (βₙξ)², so the spatial
  // ratio between beam modes and fundamental is roughly constant (~6.3× for mode 2).
  // But for larger ξ (mid-range keys ~0.5-0.55), the exact mode shapes diverge.
  var L_mm = _tineLength(midiNote);
  var xs_mm = _strikingLine(midiNote);
  var xi = Math.min(xs_mm / L_mm, 0.95);
  var spatialFund = _modeExcitation(xi, 0);
  var spatialBeam1 = _modeExcitation(xi, 1);
  var spatialBeam2 = _modeExcitation(xi, 2);
  // Beam/fundamental spatial ratio (how much more each beam mode is excited relative to fundamental)
  var spatialRatio1 = spatialBeam1 / Math.max(spatialFund, 0.001);
  var spatialRatio2 = spatialBeam2 / Math.max(spatialFund, 0.001);

  // --- Beam modes ---
  var beam1Freq = f0 * 7.11;
  var beam2Freq = f0 * 20.25;

  // Hammer spectrum filter: amplitude ∝ 1/(1 + (f/fc)²)
  // This naturally handles all register/velocity combinations:
  //   Shore 30 + low note → fc=91Hz, beam at 391Hz → 0.051 (barely excited)
  //   Wood tip + high note → fc=2122Hz, beam at 7444Hz → 0.075 (excited)
  var fundFilter = 1 / (1 + Math.pow(f0 / fc, 2));
  var beam1Filter = 1 / (1 + Math.pow(beam1Freq / fc, 2));
  var beam2Filter = 1 / (1 + Math.pow(beam2Freq / fc, 2));

  // Beam mode amplitude = hammerSpectral × spatialExcitation × frequencyResponse × tuning
  // spatialRatio: mode shape at striking point (how much the hammer excites this mode)
  // (1/freqRatio²): higher modes have less displacement per unit excitation force
  // tuningConstant: absorbs the spatial×frequency product to match empirical 0.8/0.4
  // At mid-range (ξ≈0.5): spatialRatio≈6.3, (1/7.11²)=0.020 → product≈0.124
  //   So tuningConst ≈ 0.8/0.124/refSpatial ≈ 6.5/refSpatial (calibrated below)
  var freqResp1 = 1 / (7.11 * 7.11);  // displacement ∝ 1/ω²
  var freqResp2 = 1 / (20.25 * 20.25);
  // Reference spatial ratios at mid-range (ξ≈0.5): ~6.3 and ~17.5
  // Tuning constants calibrated so mid-range output matches previous 0.8/0.4 behavior
  var beam1Rel = (beam1Filter / Math.max(fundFilter, 0.01)) * spatialRatio1 * freqResp1 * 6.5;
  var beam2Rel = (beam2Filter / Math.max(fundFilter, 0.01)) * spatialRatio2 * freqResp2 * 9.5;

  return {
    frequencies: [
      f0,
      f0,
      beam1Freq,
      beam2Freq,
    ],
    amplitudes: [
      1.0 * massScale,
      tonebarAmp * massScale,
      beam1Rel * massScale,
      beam2Rel * massScale,
    ],
    decayTimes: [
      tau * decayVar,
      tonebarDecay * decayVar,
      0.035 * decayVar * velDecayScale,
      0.015 * decayVar * velDecayScale,
    ],
  };
}

// ========================================
// REAL CABINET IR LOADER
// ========================================
// Loads measured Twin Reverb IR (Shift Line 1973 Twin 73 pack, free/open)
// Falls back to synthetic IR if fetch fails

function _loadRealCabinetIR(ctx) {
  if (_epRealIRLoaded) return;
  // Phase 3.0.f: asset relocated to audio-core/assets/. Use AUDIO_CORE_BASE
  // hook so embedded hosts (Desktop / standalone) can override the base path.
  var basePath = (typeof window !== 'undefined' && window.AUDIO_CORE_BASE) || 'audio-core/';
  fetch(basePath + 'assets/twin-cab-ir.wav')
    .then(function(r) { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
    .then(function(buf) { return ctx.decodeAudioData(buf); })
    .then(function(decoded) {
      // IR is mono 48kHz — ConvolverNode needs at least 1ch
      _epCabinetNode.buffer = decoded;
      _epRealIRLoaded = true;
    })
    .catch(function(e) {
      // Keep synthetic IR as fallback — no error to user
    });
}

// ========================================
// SPRING REVERB AudioWorklet LOADER
// ========================================
// Async upgrade: ConvolverNode plays immediately, AudioWorklet hot-swaps when ready.
// Same pattern as _loadRealCabinetIR — fallback-first, upgrade in background.

var _epSendLPF2Ref = null; // saved for hot-swap reconnection

function _loadSpringReverbWorklet(ctx) {
  if (!ctx.audioWorklet) return; // Safari <14.1 fallback to ConvolverNode
  if (_epSpringReverbWorklet) return;

  // Phase 3.0.f: AUDIO_CORE_BASE hook for embedded hosts
  var _scoreBase = (typeof window !== 'undefined' && window.AUDIO_CORE_BASE) || 'audio-core/';
  ctx.audioWorklet.addModule(_scoreBase + 'spring-reverb-processor.js')
    .then(function() {
      var workletNode = new AudioWorkletNode(ctx, 'spring-reverb-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });

      // Hot-swap: disconnect ConvolverNode, connect AudioWorkletNode
      if (_epSendLPF2Ref && _epSpringReverb && _epV4AGain) {
        _epSendLPF2Ref.disconnect(_epSpringReverb);
        _epSpringReverb.disconnect(_epV4AGain);

        _epSendLPF2Ref.connect(workletNode);
        workletNode.connect(_epV4AGain);

        _epSpringReverb = workletNode;
        _epSpringReverbWorklet = true;
      }
    })
    .catch(function(e) {
      // Keep ConvolverNode fallback — silent degradation
    });
}

// ========================================
// CABINET IR GENERATION (synthetic fallback)
// ========================================

function _createCabinetIR(ctx, type) {
  // Synthetic cabinet impulse response — Twin Reverb 2x12" Jensen C12N
  // Real speaker: bass resonance ~80Hz, body 200-400Hz,
  // PRESENCE PEAK 3-4kHz (speaker breakup mode — the "sparkle" of Twin),
  // rolloff above 5-6kHz (paper cone natural limit)
  var sr = ctx.sampleRate;
  var len = Math.floor(sr * 0.05); // 50ms
  var buf = ctx.createBuffer(2, len, sr);

  // Mode frequencies and amplitudes modeled from Jensen C12N response curves
  var modes = [
    // [freq, amplitude, decay_rate]
    [80,   0.30, 80],   // bass resonance (cone fundamental)
    [250,  0.25, 100],  // low-mid body
    [600,  0.15, 130],  // mid body
    [1200, 0.12, 150],  // upper mid
    [2500, 0.18, 180],  // presence (building toward peak)
    [3500, 0.25, 200],  // PRESENCE PEAK — speaker breakup, Twin "sparkle"
    [4500, 0.10, 250],  // high-end air (rolling off)
  ];

  for (var ch = 0; ch < 2; ch++) {
    var d = buf.getChannelData(ch);
    for (var i = 0; i < len; i++) {
      var t = i / sr;
      var sample = 0;
      // Initial impulse (direct sound)
      if (i < 3) sample += 0.6;
      // Sum of resonant modes
      for (var m = 0; m < modes.length; m++) {
        var freq = modes[m][0], amp = modes[m][1], dec = modes[m][2];
        sample += amp * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * dec);
      }
      // Slight stereo spread (dual speakers, slightly different mic positions)
      if (ch === 1 && i > 0) {
        d[i] = sample * 0.95; // subtle level difference
      } else {
        d[i] = sample;
      }
    }
  }
  return buf;
}

// (Hammer noise and metallic attack buffers removed — 2026-03-23)
// Real signal path has no air-coupled components in PU output.
// Tine vibration → PU. That's it. (Münster 2014, urinami-san)

// ========================================
// SPRING REVERB IR (Allpass cascade — Abel/Välimäki/Parker)
// ========================================
// Accutronics 4AB3C1B (Twin Reverb): 2 springs, allpass dispersion model

function _createSpringReverbIR(ctx) {
  var sr = ctx.sampleRate;
  var len = Math.floor(sr * 2.5);
  var buf = ctx.createBuffer(2, len, sr);

  var springConfigs = [
    { delay: Math.floor(0.033 * sr), numAP: 800, apCoeff: 0.70 },
    { delay: Math.floor(0.041 * sr), numAP: 900, apCoeff: 0.72 },
  ];

  var chirpLen = Math.floor(0.40 * sr);
  var reflGain = 0.88;
  var numReflections = 30;

  for (var ch = 0; ch < 2; ch++) {
    var d = buf.getChannelData(ch);

    for (var s = 0; s < springConfigs.length; s++) {
      var sp = springConfigs[s];

      // Generate chirp: impulse → allpass cascade
      var chirp = new Float32Array(chirpLen);
      chirp[0] = 1.0;
      for (var n = 0; n < sp.numAP; n++) {
        var prev_x = 0, prev_y = 0;
        for (var i = 0; i < chirpLen; i++) {
          var x = chirp[i];
          var y = sp.apCoeff * x + prev_x - sp.apCoeff * prev_y;
          chirp[i] = y;
          prev_x = x;
          prev_y = y;
        }
      }

      // Add reflections with polarity inversion at fixed ends
      // Each reflection: shorter effective chirp (energy loss = HF dies first)
      var roundTrip = sp.delay * 2;
      var stereoOffset = ch * Math.floor(0.0025 * sr);
      for (var r = 0; r < numReflections; r++) {
        var reflStart = r * roundTrip + stereoOffset;
        var gain = Math.pow(reflGain, r);
        var polarity = (r % 2 === 0) ? 1.0 : -1.0;
        // Later reflections use shorter window of chirp (attack fades out)
        var effLen = Math.floor(chirpLen / (1 + r * 0.3));
        for (var i = 0; i < effLen; i++) {
          var idx = reflStart + i;
          if (idx >= 0 && idx < len) {
            // Fade within each reflection to avoid hard cutoff
            var fade = (i < effLen - 64) ? 1.0 : (effLen - i) / 64;
            d[idx] += chirp[i] * gain * polarity * fade * 15.0 / springConfigs.length;
          }
        }
      }
    }

    // Frequency-dependent decay (LPF progressive darkening)
    var lpfBase = Math.exp(-2 * Math.PI * 5000 / sr);
    var lpState = 0;
    for (var pass = 0; pass < 3; pass++) {
      lpState = 0;
      for (var i = 0; i < len; i++) {
        lpState = lpfBase * lpState + (1 - lpfBase) * d[i];
        var t = i / sr;
        var blend = Math.min(1, t / 2.5);
        d[i] = d[i] * (1 - blend * 0.3) + lpState * blend * 0.3;
      }
    }

    // Bandpass 100Hz-6kHz
    var hpAlpha = 1 - Math.exp(-2 * Math.PI * 100 / sr);
    var lpAlpha2 = Math.exp(-2 * Math.PI * 6000 / sr);
    var hpPrev = 0, lpPrev = 0;
    for (var i = 0; i < len; i++) {
      var hpOut = d[i] - hpPrev;
      hpPrev += hpAlpha * hpOut;
      lpPrev = lpAlpha2 * lpPrev + (1 - lpAlpha2) * hpOut;
      d[i] = lpPrev;
    }

    // RMS normalize
    var rmsSum = 0;
    for (var i = 0; i < len; i++) rmsSum += d[i] * d[i];
    var rms = Math.sqrt(rmsSum / len);
    if (rms > 0) {
      var scale = 0.15 / rms;
      for (var i = 0; i < len; i++) {
        d[i] = Math.max(-1, Math.min(1, d[i] * scale));
      }
    }
  }

  return buf;
}

// ========================================
// INITIALIZATION
// ========================================

function epianoInit(ctx, masterDest) {
  if (_epInitialized) return;

  // === AB763 SHARED SIGNAL CHAIN (correct Fender reverb routing) ===
  //
  // Real AB763 Vibrato channel signal flow:
  //   V1A → V2A(CF) → tonestack → Volume pot
  //     ├─ [SEND] HPF(318Hz) → V3(12AT7) → spring tank → V4A(recovery) → reverb pot ─┐
  //     └─ [DRY]  V2B(gain) ──────────────────────────────────────────────────────────────┤
  //                                                     passive mix at V4B grid ←─────────┘
  //                                                             ↓
  //                                                     V4B (12AX7, 3rd gain stage)
  //                                                             ↓
  //                                                     tremolo → phase inverter
  //                                                             ↓
  //                                                     poweramp (4×6L6) → cabinet
  //
  // Key insight: wet and dry go through the SAME V4B → poweramp → cabinet.
  // Their interaction in V4B creates the "bloom" — harmonics that neither signal
  // produces alone. This is why routing matters more than IR quality.

  // --- 1. Cabinet (end of chain) ---
  _epCabinetNode = ctx.createConvolver();
  _epCabinetNode.buffer = _createCabinetIR(ctx, 'twin');
  _epCabinetGain = ctx.createGain();
  _epCabinetGain.gain.setValueAtTime(6.0, 0); // rebalanced for gain staging redesign
  _epCabinetNode.connect(_epCabinetGain);
  _epCabinetGain.connect(masterDest);
  _loadRealCabinetIR(ctx);

  // --- 2. Shared poweramp (6L6 push-pull Class AB) ---
  // Moved from per-voice to shared: all notes interact in the power stage
  // (real amp has ONE power amp for all notes)
  _epSharedPowerMakeup = ctx.createGain();
  _epSharedPowerMakeup.gain.setValueAtTime(2.0, 0); // compensates for poweramp unity-gain normalization
  _epSharedPowerMakeup.connect(_epCabinetNode);

  _epSharedPoweramp = ctx.createWaveShaper();
  _epSharedPoweramp.oversample = '2x';
  _epSharedPoweramp.connect(_epSharedPowerMakeup);

  _epPowerDrive = ctx.createGain();
  _epPowerDrive.gain.setValueAtTime(EpState.powerampDrive, 0);
  _epPowerDrive.connect(_epSharedPoweramp);

  // --- 3. V4B: post-mix tube stage (12AX7) ---
  // Wet + dry sum at V4B's grid through passive resistor network.
  // V4B's nonlinearity creates intermodulation between reverb tail and notes = "bloom".
  // Uses same 12AX7 characteristics as V1A/V2B (shared cathode with V4A: 820Ω)
  _epV4BMakeup = ctx.createGain();
  _epV4BMakeup.gain.setValueAtTime(1.5, 0); // V4B is now unity-gain; makeup provides actual gain
  _epV4BMakeup.connect(_epPowerDrive);

  _epV4B = ctx.createWaveShaper();
  // V4B LUT: 12AX7 normalized to unity center gain (no amplification in linear region)
  // Small signals pass through unchanged (no intermodulation/metallic artifacts).
  // Large signals get soft-clipped (tube compression for chords = "bloom").
  // Raw 12AX7 LUT has center slope ~2.0; dividing by slope gives unity gain.
  var v4bRaw = computePreampLUT_12AX7();
  var v4bCenter = Math.floor(EP_LUT_SIZE / 2);
  var v4bDx = 2.0 / EP_LUT_SIZE;
  var v4bSlope = (v4bRaw[v4bCenter + 1] - v4bRaw[v4bCenter - 1]) / (2 * v4bDx);
  if (v4bSlope > 1.0) {
    for (var i = 0; i < EP_LUT_SIZE; i++) v4bRaw[i] /= v4bSlope;
  }
  _epV4B.curve = v4bRaw;
  _epV4B.oversample = 'none';
  _epV4B.connect(_epV4BMakeup);

  // --- 4. Harp wiring LPF (series-parallel pickup array) ---
  // Single Rhodes PU: L≈150mH, R≈180Ω, C_self≈30pF → resonance ~18kHz (inaudible).
  // But the HARP wiring (73-key: 24 groups of 3 parallel → series) creates:
  //   L_total ≈ 24 × (150mH / 3) = 1.2H
  //   R_total ≈ 24 × (180Ω / 3) = 1,440Ω (matches EP-Forum measurements)
  //   C_total = cable (~300pF) + preamp input (~50pF) ≈ 350pF
  //   f_res = 1/(2π√(1.2 × 350e-12)) ≈ 7,800 Hz
  //   Q = (1/R) × √(L/C) ≈ (1/1440) × √(1.2/350e-12) ≈ 1.3
  // This is the real LPF that shapes the Rhodes output before the preamp.
  // With 20ft cable (650pF total) + Rhodes 25kΩ Volume pot loading:
  //   f_res = 1/(2π√(1.2H × 650pF)) = 5,699Hz
  //   Q = 0.6 (Volume pot at 25kΩ) to 1.1 (Volume pot full open at 50kΩ)
  // Old: 7.8kHz/Q=1.3 (no cable, no volume pot load). Too bright, painful 2-5kHz.
  // Sources: Wheeler calc, EP-Forum, cable capacitance 50pF/m standard
  _epHarpLPF = ctx.createBiquadFilter();
  _epHarpLPF.type = 'lowpass';
  _epHarpLPF.frequency.setValueAtTime(5700, 0);
  _epHarpLPF.Q.setValueAtTime(0.8, 0); // Volume pot ~halfway between full(1.1) and half(0.6)

  // --- 4b. Dry bus ---
  // Per-voice V2B outputs sum here → through harp LPF → V4B.
  _epDryBus = ctx.createGain();
  _epDryBus.gain.setValueAtTime(0.7, 0);
  _epDryBus.connect(_epHarpLPF);
  _epHarpLPF.connect(_epV4B);

  // --- 5. Reverb send chain: HPF → V3 → spring → V4A → pot → V4B ---

  // 5a. HPF: 500pF / 1MΩ RC network (-3dB at 318Hz)
  // Keeps bass out of reverb — critical because spring tank input impedance
  // is reactive (lower at low freq → bass draws more current → mud)
  _epSendHPF = ctx.createBiquadFilter();
  _epSendHPF.type = 'highpass';
  _epSendHPF.frequency.setValueAtTime(318, 0);
  _epSendHPF.Q.setValueAtTime(0.707, 0);

  // 5b. Reverb send bandwidth limiting (3-layer model of real circuit)
  //
  // Real AB763 reverb send has THREE mechanisms that limit HF:
  //   1. Hammond 1750A transformer leakage inductance → gentle rolloff
  //   2. Tank drive coil is INDUCTIVE: impedance ∝ frequency (14.75kΩ at 10kHz)
  //      + 22kΩ parallel resistor → constant current drive limited to ~6.5kHz
  //   3. Mechanical spring response → "output above 7kHz is almost nil"
  //
  // Combined: passes 200Hz-6kHz, steep cliff above 6-7kHz.
  // Model: highshelf (gradual tilt from coil inductance)
  //        + 2-stage LPF at 5kHz (transformer + mechanical cutoff)
  //
  // Ref: sound-au.com/articles/reverb.htm, ampbooks.com/classic-circuits/reverb/

  // 5c. V3 reverb driver (12AT7 parallel triodes)
  // Signal path: HPF → V3 drive → V3 WS → transformer → tank
  // V3 amplifies the post-tonestack signal, then transformer filters V3's output.
  // CRITICAL: transformer is AFTER V3, so V3's generated harmonics get filtered too.
  _epV3LUT = computeV3DriverLUT_12AT7();
  _epV3Drive = ctx.createGain();
  _epV3Drive.gain.setValueAtTime(Math.max(EpState.springDwell, 0.5), 0); // Dwell: send drive. Min 0.5 (real pot never reaches true zero)
  _epV3Driver = ctx.createWaveShaper();
  _epV3Driver.curve = _epV3LUT;
  _epV3Driver.oversample = 'none';
  _epSendHPF.connect(_epV3Drive);
  _epV3Drive.connect(_epV3Driver);

  // 5d. Post-V3 bandwidth limiting (Hammond 1750A transformer + tank input)
  //
  // This goes AFTER V3 — the transformer filters V3's output including
  // any harmonics generated by the tube's nonlinearity.
  //
  // Real circuit has THREE mechanisms:
  //   1. Hammond 1750A leakage inductance → gentle HF rolloff
  //   2. Tank drive coil is INDUCTIVE: impedance ∝ freq (14.75kΩ at 10kHz)
  //      + 22kΩ parallel resistor → constant current drive limited to ~6.5kHz
  //   3. Mechanical spring response → "output above 7kHz is almost nil"
  //
  // Model: highshelf (coil inductance tilt) + 2-stage LPF (transformer + mechanical)
  // Ref: sound-au.com/articles/reverb.htm, ampbooks.com/classic-circuits/reverb/

  // Layer 1: inductive tilt (-6dB shelf above 3kHz, models coil impedance rise)
  var _epSendTilt = ctx.createBiquadFilter();
  _epSendTilt.type = 'highshelf';
  _epSendTilt.frequency.setValueAtTime(3000, 0);
  _epSendTilt.gain.setValueAtTime(-6, 0);
  _epV3Driver.connect(_epSendTilt);

  // Layer 2+3: transformer + mechanical cutoff (steep above 5kHz)
  var _epSendLPF1 = ctx.createBiquadFilter();
  _epSendLPF1.type = 'lowpass';
  _epSendLPF1.frequency.setValueAtTime(5000, 0);
  _epSendLPF1.Q.setValueAtTime(0.707, 0);
  var _epSendLPF2 = ctx.createBiquadFilter();
  _epSendLPF2.type = 'lowpass';
  _epSendLPF2.frequency.setValueAtTime(5000, 0);
  _epSendLPF2.Q.setValueAtTime(0.707, 0);
  _epSendTilt.connect(_epSendLPF1);
  _epSendLPF1.connect(_epSendLPF2);

  // 5c. Spring reverb (Accutronics 4AB3C1B)
  // Immediate: ConvolverNode with synthetic IR (fallback)
  // Background: AudioWorklet with Välimäki parametric model (primary)
  _epSpringReverb = ctx.createConvolver();
  _epSpringReverb.buffer = _createSpringReverbIR(ctx);
  _epSendLPF2.connect(_epSpringReverb);
  _epSendLPF2Ref = _epSendLPF2; // save for future hot-swap reconnection
  // AudioWorklet spring reverb: Abel waveguide structure (US8391504B1).
  // D(z) at output only (not in loop) → tail energy preserved, chirp per echo.
  // Replaces Välimäki approach (allpass in loop → tail dissipated).
  _loadSpringReverbWorklet(ctx);

  // 5d. V4A recovery amp (~36dB voltage gain, essentially linear)
  // Signal from tank output is millivolts — V4A brings it to line level.
  // Shares 820Ω cathode resistor with V4B (runs clean due to tiny input signal)
  _epV4AGain = ctx.createGain();
  // V4A gain: recovery amplifier (real 12AX7: ~36dB ≈ ×63).
  // AudioWorklet (Abel waveguide): output is energy-preserving BUT 20 stretched allpass
  // stages spread energy over ~2ms → peak drops to ~1/√112 of input.
  // Need significant recovery gain to bring wet to audible level relative to dry bus (0.22).
  // V4A=5.0 with pot=0.12: worklet_peak × 5.0 × 0.12 ≈ usable wet level.
  _epV4AGain.gain.setValueAtTime(5.0, 0); // Recovery amp for AudioWorklet (strong to make reverb audible)
  _epSpringReverb.connect(_epV4AGain);

  // 5e. Reverb pot (100kΩ log, controls RETURN level — send is always full)
  // Models 470kΩ/220kΩ resistive divider at V4B grid (passes 32%)
  _epReverbPot = ctx.createGain();
  _epReverbPot.gain.setValueAtTime(EpState.springReverbMix, 0);
  _epV4AGain.connect(_epReverbPot);
  _epReverbPot.connect(_epV4B); // wet → V4B (meets dry at same node)

  // Default LUTs
  epianoUpdateLUTs();
  _epInitialized = true;
}

function epianoUpdateLUTs() {
  var preset = EP_AMP_PRESETS[EpState.preset] || EP_AMP_PRESETS['Rhodes DI'];

  // Pickup LUT
  if (preset.pickupType === 'wurlitzer') {
    _epPickupLUT = computePickupLUT_Wurlitzer(EpState.pickupDistance);
  } else {
    _epPickupLUT = computePickupLUT_Rhodes(EpState.pickupSymmetry, EpState.pickupDistance);
  }

  // Preamp LUT
  if (preset.preampType === '12AX7') {
    _epPreampLUT = computePreampLUT_12AX7();
  } else if (preset.preampType === 'NE5534') {
    _epPreampLUT = computePreampLUT_NE5534();
  } else if (preset.preampType === 'Si2N3392_2stage') {
    _epPreampLUT = computePreampLUT_Si2N3392_2stage();
  } else if (preset.preampType === 'BJT') {
    _epPreampLUT = computePreampLUT_BJT();
  } else {
    _epPreampLUT = null;
  }

  // Poweramp LUT
  if (preset.powerampType === '6L6') {
    _epPowerampLUT = computePowerampLUT_6L6();
  } else if (preset.powerampType === 'GeTr') {
    _epPowerampLUT = computePowerampLUT_GeTr();
  } else if (preset.powerampType === 'SS') {
    _epPowerampLUT = computePowerampLUT_SS();
  } else {
    _epPowerampLUT = null;
  }

  // Update shared WaveShapers (these persist across noteOn/noteOff)
  if (_epSharedPoweramp && _epPowerampLUT) {
    // Normalize to unity center gain (same as V4B — prevents hidden amplification
    // that creates intermodulation and rounds off bell/chime quality)
    var paCenter = Math.floor(EP_LUT_SIZE / 2);
    var paDx = 2.0 / EP_LUT_SIZE;
    var paSlope = (_epPowerampLUT[paCenter + 1] - _epPowerampLUT[paCenter - 1]) / (2 * paDx);
    if (paSlope > 1.0) {
      for (var i = 0; i < EP_LUT_SIZE; i++) _epPowerampLUT[i] /= paSlope;
    }
    _epSharedPoweramp.curve = _epPowerampLUT;
  }
}

// ========================================
// VOICE CREATION (noteOn)
// ========================================

function epianoNoteOn(ctx, midi, velocity, masterDest) {
  if (!_epInitialized) epianoInit(ctx, masterDest);

  var preset = EP_AMP_PRESETS[EpState.preset] || EP_AMP_PRESETS['Rhodes DI'];
  var now = ctx.currentTime;
  var modes = computeModeFrequencies(midi, velocity);
  var nodes = []; // track all nodes for cleanup

  // --- 1. Modal synthesis: hybrid (attack buffer + live sustain) ---
  // The tine is ONE physical body. Attack transient (beam modes) must be
  // phase-coherent → AudioBuffer. Sustain (fundamental) must be live → OscillatorNode.
  //
  // Attack buffer: all modes at phase 0, with decay envelopes.
  //   Beam modes decay in ~35ms, so buffer only needs ~100ms.
  //   Includes fundamental component that crossfades out as OscillatorNode takes over.
  // Sustain oscillator: pure fundamental, starts at the same time.
  //   Fades in over ~50ms to replace the fundamental in the attack buffer.
  //
  // Both sum at voiceMixer → PU WaveShaper sees ONE waveform at any instant.
  // No separate beam mode oscillators → no beating with WS harmonics.

  var tineAmplitude = Math.sqrt(velocity) * 0.3;
  var voiceMixer = ctx.createGain();
  voiceMixer.gain.setValueAtTime(tineAmplitude, now);
  nodes.push(voiceMixer);

  // --- PU electromagnetic damping (Lenz's law) ---
  var puDampStrength = velocity * (1.1 - EpState.pickupDistance);
  puDampStrength = Math.max(0, Math.min(1, puDampStrength));
  var emDampRatio = 1.0 - puDampStrength * 0.4;
  var emDampTime = 0.025;

  // --- Attack buffer (beam modes + fundamental onset, ~150ms) ---
  var sampleRate = ctx.sampleRate;
  var attackDur = 0.15; // 150ms covers beam mode decay (35ms) + settling
  var attackLen = Math.ceil(attackDur * sampleRate);
  var attackBuffer = ctx.createBuffer(1, attackLen, sampleRate);
  var atkData = attackBuffer.getChannelData(0);
  var crossfadeTime = 0.05; // 50ms crossfade from buffer fundamental → oscillator
  var crossfadeSamples = Math.ceil(crossfadeTime * sampleRate);

  for (var m = 0; m < modes.frequencies.length; m++) {
    var freq = modes.frequencies[m];
    if (freq > sampleRate / 2) continue;
    var amp = modes.amplitudes[m];
    if (Math.abs(amp) < 0.001) continue;
    var tau_m = modes.decayTimes[m];
    var omega = 2 * Math.PI * freq / sampleRate;
    var isBeamMode = (m >= 2); // modes 0,1 = fundamental/tonebar, 2,3 = beam modes
    var isFundamental = (m <= 1);

    for (var i = 0; i < attackLen; i++) {
      var t = i / sampleRate;
      // Decay envelope (EM braking + mechanical)
      var env;
      if (t < emDampTime * 3) {
        env = amp * (1.0 + (emDampRatio - 1.0) * (1 - Math.exp(-t / emDampTime)));
      } else {
        env = amp * emDampRatio * Math.exp(-(t - emDampTime * 3) / tau_m);
      }
      // Fundamental/tonebar: fade out in buffer as oscillator takes over
      if (isFundamental && i > crossfadeSamples) {
        var fadeFrac = (i - crossfadeSamples) / (attackLen - crossfadeSamples);
        env *= (1.0 - fadeFrac); // linear fadeout
      }
      atkData[i] += env * Math.sin(omega * i);
    }
  }

  var attackSource = ctx.createBufferSource();
  attackSource.buffer = attackBuffer;
  attackSource.connect(voiceMixer);
  attackSource.start(now);
  nodes.push(attackSource);

  // --- Sustain oscillator (fundamental only, live) ---
  var f0 = modes.frequencies[0];
  var sustainAmp = modes.amplitudes[0] * emDampRatio;
  var sustainOsc = ctx.createOscillator();
  sustainOsc.type = 'sine';
  sustainOsc.frequency.setValueAtTime(f0, now);

  var sustainGain = ctx.createGain();
  // Fade in: silent during attack buffer's fundamental, then take over
  sustainGain.gain.setValueAtTime(0, now);
  sustainGain.gain.linearRampToValueAtTime(sustainAmp, now + attackDur);
  // Then normal Q-based decay
  sustainGain.gain.setTargetAtTime(0, now + attackDur, modes.decayTimes[0]);

  sustainOsc.connect(sustainGain);
  sustainGain.connect(voiceMixer);
  sustainOsc.start(now);
  var oscillators = [sustainOsc];
  nodes.push(sustainOsc, sustainGain);

  // --- 2. Pickup nonlinearity ---
  // Physics: tine vibrates → passes through PU magnetic field → EMF = g(q) × dq/dt
  // No "drive" knob exists in real Rhodes. The LUT shape (from Lhor, Lver) and
  // tine amplitude (from velocity) fully determine the output. Nothing else.
  //
  // Per-note PU LUT: computed with physical PU gap for this register.
  //   Bass/treble: wider gap (1.588mm) → gentler curve → less nonlinearity
  //   Mid: narrow gap (0.794mm) → steeper curve → more nonlinearity
  // Per-note q range: WaveShaper [-1,+1] maps to physical tine displacement range.
  //   Bass: large displacement → LUT covers wide sweep → tine passes PU → growl
  //   Treble: tiny displacement → LUT zooms center → stays linear → bell
  var tipFactor = _tipDisplacementFactor(midi);
  var gapMm = _puGapMm(midi);
  var gapScale = gapMm / 0.794; // 1.0 at mid-range reference
  // qRange: how much of the LUT's q-space this key explores.
  // tipFactor > 1 (bass): wider q range → LUT includes the far-from-PU regions
  // tipFactor < 1 (treble): narrow q range → LUT concentrated on center
  // Clamp to reasonable range to avoid LUT resolution issues
  var qRange = Math.max(0.3, Math.min(5.0, tipFactor));
  var voicedDistance = pickupVoicedDistance(
    EpState.pickupDistance,
    midi,
    epPresetOrStateNumber(preset, 'pickupBassBoost', 1.5),
    epPresetOrStateNumber(preset, 'pickupBassMinRatio', 0.75),
    epPresetOrStateNumber(preset, 'pickupMinRatio', 0.7)
  );

  var lastNode = voiceMixer;
  if (preset.pickupType === 'rhodes') {
    // Per-note PU LUT with physical gap and displacement range
    var noteLUT = computePickupLUT_Rhodes(EpState.pickupSymmetry, voicedDistance, gapScale, qRange);
    var pickupWS = ctx.createWaveShaper();
    pickupWS.curve = noteLUT;
    pickupWS.oversample = 'none';
    // Input gain: no longer the ad-hoc pitchPUScale.
    // The per-note LUT already encodes the physical displacement range (qRange)
    // and PU gap (gapScale). The input just needs to be in [-1,+1].
    // tineAmplitude handles velocity. No separate pitch scaling needed.
    var puInput = ctx.createGain();
    puInput.gain.setValueAtTime(1.0, now);
    lastNode.connect(puInput);
    puInput.connect(pickupWS);
    lastNode = pickupWS;
    nodes.push(puInput, pickupWS);
  } else if (_epPickupLUT) {
    // Wurlitzer / other presets: use shared LUT (no per-register physics)
    var pickupWS = ctx.createWaveShaper();
    pickupWS.curve = _epPickupLUT;
    pickupWS.oversample = 'none';
    var puInput = ctx.createGain();
    puInput.gain.setValueAtTime(1.0, now);
    lastNode.connect(puInput);
    puInput.connect(pickupWS);
    lastNode = pickupWS;
    nodes.push(puInput, pickupWS);
  }

  // --- 3b. Single pickup coil: L ≈ 150mH, R ≈ 180Ω ---
  // Rhodes pickup: ~3000 turns AWG 38, AlNiCo 5 magnet, DC resistance 170-190Ω.
  // Calculated inductance ~150mH (Wheeler formula, confirmed by L/R ratio analysis).
  // With C_self ~30pF: f_res ≈ 18kHz — ABOVE audible range.
  // → Single pickup is electrically transparent. NO per-voice filter needed.
  // The audible filtering comes from the HARP WIRING (series-parallel groups)
  // which is modeled in epianoInit() as a shared filter.
  //
  // Sources: EP-Forum (DC R), Shadetree Keys (~3100 turns), The Gear Page (~2900 turns),
  // Wheeler formula calculation, Horton & Moore (2009) methodology.

  // --- 3c. Coupling capacitor HPF (0.047μF + 1MΩ grid leak = 3.4Hz) ---
  // AB763 Normal channel: 0.047μF coupling cap to V1A grid.
  // f_c = 1/(2π × 0.047e-6 × 1e6) = 3.39 Hz — subsonic, removes DC offset.
  {
    var couplingHPF = ctx.createBiquadFilter();
    couplingHPF.type = 'highpass';
    couplingHPF.frequency.setValueAtTime(3.4, now);
    couplingHPF.Q.setValueAtTime(0.707, now); // Butterworth
    lastNode.connect(couplingHPF);
    lastNode = couplingHPF;
    nodes.push(couplingHPF);
  }

  // --- 3d. Input jack attenuator (AB763 Hi input) ---
  // AB763 Normal channel Hi input: two 68kΩ resistors in voltage divider.
  // Signal at grid = input × 68k/(68k+68k) = ×0.5 = -6dB.
  // Lo input would be ~-20dB (additional 68kΩ to ground). Rhodes uses Hi.
  // 2026-04-22: Peterson Suitcase fig11-8 にはこの divider は無い。12AX7 限定で発火。
  if (preset.preampType === '12AX7') {
    var inputAtten = ctx.createGain();
    inputAtten.gain.setValueAtTime(0.5, now); // -6dB: AB763 Hi input divider
    lastNode.connect(inputAtten);
    lastNode = inputAtten;
    nodes.push(inputAtten);
  }

  // --- 4. Preamp ---
  if (_epPreampLUT) {
    var preampInputGain = ctx.createGain();
    preampInputGain.gain.setValueAtTime(EpState.preampGain, now);
    lastNode.connect(preampInputGain);
    lastNode = preampInputGain;
    nodes.push(preampInputGain);

    var preampWS = ctx.createWaveShaper();
    preampWS.curve = _epPreampLUT;
    preampWS.oversample = '2x';
    lastNode.connect(preampWS);
    lastNode = preampWS;
    nodes.push(preampWS);
    // Makeup gain after preamp — keep within ±1 for next stage
    var preampMakeup = ctx.createGain();
    preampMakeup.gain.setValueAtTime(1.0, now);
    lastNode.connect(preampMakeup);
    lastNode = preampMakeup;
    nodes.push(preampMakeup);
  }

  // --- 4b. Cathode Follower (V2A) — impedance buffer ---
  // AB763: V2A sits between V1A and tonestack. Gain ≈ 1 (slight loss from
  // cathode follower topology), low output impedance to drive passive tonestack
  // without loading. Minimal nonlinearity — modeled as simple gain.
  if (preset.preampType === '12AX7' && EpState.use2ndPreamp) {
    var cfGain = ctx.createGain();
    cfGain.gain.setValueAtTime(0.95, now);
    lastNode.connect(cfGain);
    lastNode = cfGain;
    nodes.push(cfGain);
  }

  // --- 5. Tonestack (Passive RC — linear filter only) ---
  // AB763 TMB is a passive RC network: NO nonlinear behavior.
  // Carbon comp resistor "nonlinearity" is unmeasurable in AC audio applications
  // (no DC bias across signal components). WaveShaper removed (2026-03-23).
  // Future: replace Biquad approximation with Yeh & Smith 3rd-order IIR (AudioWorklet).
  if (preset.useTonestack) {
    var tsP = computeTonestackParams(
      EpState.tonestackBass, EpState.tonestackMid, EpState.tonestackTreble,
      EpState.brightSwitch
    );

    // 5a. DC blocking HPF
    var tsHPF = ctx.createBiquadFilter();
    tsHPF.type = tsP.hpf.type;
    tsHPF.frequency.setValueAtTime(tsP.hpf.frequency, now);
    tsHPF.Q.setValueAtTime(tsP.hpf.Q, now);
    lastNode.connect(tsHPF);
    lastNode = tsHPF;
    nodes.push(tsHPF);

    // 5b. Low shelf (bass)
    var tsLow = ctx.createBiquadFilter();
    tsLow.type = tsP.lowShelf.type;
    tsLow.frequency.setValueAtTime(tsP.lowShelf.frequency, now);
    tsLow.gain.setValueAtTime(tsP.lowShelf.gain, now);
    lastNode.connect(tsLow);
    lastNode = tsLow;
    nodes.push(tsLow);

    // 5c. Mid scoop (peaking EQ — THE Fender signature)
    var tsMid = ctx.createBiquadFilter();
    tsMid.type = tsP.midScoop.type;
    tsMid.frequency.setValueAtTime(tsP.midScoop.frequency, now);
    tsMid.Q.setValueAtTime(tsP.midScoop.Q, now);
    tsMid.gain.setValueAtTime(tsP.midScoop.gain, now);
    lastNode.connect(tsMid);
    lastNode = tsMid;
    nodes.push(tsMid);

    // 5d. High shelf (treble + bright switch)
    var tsHigh = ctx.createBiquadFilter();
    tsHigh.type = tsP.highShelf.type;
    tsHigh.frequency.setValueAtTime(tsP.highShelf.frequency, now);
    tsHigh.gain.setValueAtTime(tsP.highShelf.gain, now);
    lastNode.connect(tsHigh);
    lastNode = tsHigh;
    nodes.push(tsHigh);
  }

  // --- 5.5. Tonestack insertion loss ---
  // Real Fender TMB is a passive voltage divider. Even at "neutral" knob settings,
  // broadband insertion loss is -23 to -25dB. The Biquad shelves model the
  // frequency SHAPE (~-5dB) but NOT the insertion loss.
  // This GainNode models the missing ~-18dB (total with Biquads ≈ -23dB).
  // "昔はできるだけクリーンに作りたかった。でも出来なかっただけ" — urinami-san
  if (preset.useTonestack) {
    var tsInsertionLoss = ctx.createGain();
    tsInsertionLoss.gain.setValueAtTime(0.2, now); // -14dB: passive RC voltage divider loss (studio level)
    lastNode.connect(tsInsertionLoss);
    lastNode = tsInsertionLoss;
    nodes.push(tsInsertionLoss);
  }

  // --- 5.6. Reverb send (AB763: post-tonestack → HPF(318Hz) → V3 → spring → V4A → pot → V4B) ---
  // Send taps AFTER tonestack insertion loss (matches real AB763: send is post-Volume-pot level).
  // V3 (12AT7) drives the tank — mostly clean, compresses HF transients when driven.
  // Wet returns through V4A recovery and meets dry at V4B (shared "bloom" stage).
  if (_epSendHPF && preset.useSpringReverb) {
    lastNode.connect(_epSendHPF);
  }

  // --- 5a. Volume pot (AB763: between tonestack and V2B) ---
  // AB763: Volume pot is an audio-taper potentiometer.
  // At "5" (noon): approximately -10dB (0.32). At "10" (max): 0dB (1.0).
  // Rhodes through Twin: typically Volume at 4-6 for clean tone.
  // This is the PRIMARY gain control that was missing from our chain.
  if (preset.useTonestack) {
    var volumePot = ctx.createGain();
    volumePot.gain.setValueAtTime(0.5, now); // Volume at "6-7" = -6dB (typical Rhodes clean setting)
    lastNode.connect(volumePot);
    lastNode = volumePot;
    nodes.push(volumePot);
  }

  // --- 5b. 2nd Preamp Stage (V2B) — recovery amp after tonestack ---
  // AB763: V2B recovers the tonestack + volume pot loss (×57 in real circuit).
  // Real V2B: 47mV in → 2.7V out.
  if (preset.preampType === '12AX7' && _epPreampLUT && EpState.use2ndPreamp) {
    var preamp2InputGain = ctx.createGain();
    preamp2InputGain.gain.setValueAtTime(5.0, now); // fixed recovery
    lastNode.connect(preamp2InputGain);
    lastNode = preamp2InputGain;
    nodes.push(preamp2InputGain);

    var preamp2WS = ctx.createWaveShaper();
    preamp2WS.curve = _epPreampLUT;
    preamp2WS.oversample = 'none'; // latency budget: PU(none)+V1A(2x)+V2B(none)+power(2x) = 2 stages at 2x
    lastNode.connect(preamp2WS);
    lastNode = preamp2WS;
    nodes.push(preamp2WS);

    // Makeup gain — V2B recovery output
    var preamp2Makeup = ctx.createGain();
    preamp2Makeup.gain.setValueAtTime(1.5, now); // compensates WS compression + feeds dry bus at correct level
    lastNode.connect(preamp2Makeup);
    lastNode = preamp2Makeup;
    nodes.push(preamp2Makeup);
  }

  // --- 6. Route to shared chain or direct output ---
  // Harp wiring LPF (5.7kHz): part of the INSTRUMENT (not the amp).
  // L=1.2H + cable 650pF + Volume pot 25kΩ → RLC resonance at 5.7kHz, Q≈0.8.
  //
  // Cabinet presets: lastNode → dryBus → harpLPF → V4B → poweramp → cabinet
  //   (dryBus → harpLPF → V4B chain is wired in epianoInit)
  // DI preset: lastNode → per-voice harpLPF → masterDest
  //   (separate harpLPF per voice, bypasses entire amp chain)
  if (preset.useCabinet && _epDryBus) {
    lastNode.connect(_epDryBus);
  } else {
    // DI: per-voice harp LPF → direct output (no amp chain)
    var diHarpLPF = ctx.createBiquadFilter();
    diHarpLPF.type = 'lowpass';
    diHarpLPF.frequency.setValueAtTime(5700, now);
    diHarpLPF.Q.setValueAtTime(0.8, now);
    lastNode.connect(diHarpLPF);
    diHarpLPF.connect(masterDest);
    nodes.push(diHarpLPF);
  }

  // --- Voice envelope object (matching existing interface) ---
  var maxDecay = Math.max.apply(null, modes.decayTimes);
  var stopTime = now + maxDecay * 5; // 5 time constants ≈ silence

  // Schedule auto-stop
  for (var i = 0; i < oscillators.length; i++) {
    oscillators[i].stop(stopTime);
  }

  var _cancelled = false;

  return {
    cancel: function() {
      if (_cancelled) return;
      _cancelled = true;
      var t = ctx.currentTime;
      // Damper: fast exponential decay
      voiceMixer.gain.cancelScheduledValues(t);
      voiceMixer.gain.setValueAtTime(voiceMixer.gain.value, t);
      voiceMixer.gain.setTargetAtTime(0, t, 0.05); // 50ms release
      // Stop oscillators after fadeout
      var releaseStop = t + 0.3;
      for (var i = 0; i < oscillators.length; i++) {
        try { oscillators[i].stop(releaseStop); } catch(_){}
      }
      // Disconnect all nodes after cleanup
      setTimeout(function() {
        for (var i = 0; i < nodes.length; i++) {
          try { nodes[i].disconnect(); } catch(_){}
        }
      }, 500);
    },
  };
}
