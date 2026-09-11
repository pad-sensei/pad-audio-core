# audio-core CHANGELOG

**目的**: submodule に変更を加える consumer（64PE / Keys / Effects / MRC / Desktop）が、bump 時に「何が変わったか」を 1 箇所で把握するための記録。

**規律**: commit 時に必ずこのファイルに entry を追記する（urinami 2026-04-15 方針、記憶の外化）。

---

## Entry format

```markdown
## [YYYY-MM-DD] {commit-sha-short} — {short title}

### BREAKING
- interface 変更 / schema 互換切れ / signature 変更
- consumer 側の対応内容を明記

### Feature
- 新機能 / 新 API / 新 preset

### Fix
- bug 修正（API 不変）
```

カテゴリなしは書かない。BREAKING なければその section ごと省く。

---

## Consumer bump workflow

1. 該当 consumer repo で `git submodule update --remote audio-core`
2. この CHANGELOG 末尾から自分が最後に bump した時点までを読む
3. **BREAKING あり** → adapter 更新（audioCoreConfig 該当 sub-interface の実装修正）+ smoke test 全項目
4. **BREAKING なし** → smoke test S1-S3（first-note / preset / persistence）
5. consumer repo で `git add audio-core && git commit -m "chore: bump audio-core to {sha}"`

consumer が何を smoke test するかは各 consumer の `CLAUDE.md` を参照。

---

# 履歴

## [2026-09-11] {pending-sha} — sustain for non-worklet voices

### Fix
- CC64 sustain now holds sampler / WebAudioFont / non-worklet fallback voices after physical NoteOff and releases them on pedal-up.
- Re-triggering a sustained pitch replaces the deferred voice immediately, so a later pedal-up cannot kill the new attack.
- `noteOffAll()` clears deferred sustain state and now schedules the same delayed saturation-node cleanup used by ordinary NoteOff, closing the previous all-notes-off resource leak.
- E-piano AudioWorklet behavior is unchanged: NoteOff still reaches the DSP immediately and `epianoWorkletSetSustain()` remains authoritative there.

### BREAKING なし
- Public function signatures and consumer API are unchanged.

## [2026-07-10] {pending-sha} — Pad Sensei MK1 v0.26 voicing port

### Feature
- Pad Sensei MK1 v0.26 の factory preset voicing を `Rhodes DI` / `Rhodes Suitcase Clean` / `Drive` / `Vintage` に反映
- 低音域の pickup drive / distance voicing を preset ごとに制御できる内部パラメータを追加
- AudioWorklet と fallback engine の両方で低音域の pickup distance voicing を適用

### BREAKING なし
- Message API / schemaVersion / noteOn signature は変更なし。
- 既存 consumer は audio-core submodule を bump するだけで従来通り動作。

## [2026-06-27] {pending-sha} — Pad Sensei MK1 v0.22 physical engine voicing port

### Feature
- `epiano-worklet-processor.js` に Pad Sensei MK1 v0.22 相当の物理エンジン調整を移植:
  - Zener 型の周波数依存 modal damping
  - mode 5 を主対象にした高次 mode decay tuning
  - velocity 依存の dynamic tine drive
  - pickup symmetry / distance の register voicing
  - bass PU position drive boost
  - per-key high register compensation
  - low bass post-pickup trim
  - CdS tremolo の時定数と stereo width 調整
  - final hard clip を asymmetric soft clip に置換

### BREAKING なし
- Message API / schemaVersion / noteOn signature は変更なし。
- 音色は大きく変わるため、consumer bump 後は耳判定と release-gates を必須にする。

## [2026-04-27] {pending-sha} — autoFilterVol 追加 (output trim, アンプ前段過大入力回避)

### Feature
- **`autoFilterVol` (0-2, default 1.0) 追加** in `audio-effects.js`:
  - chain: `autoFilterMix → autoFilterVolGain → phaserFilters[0] / phaserMix`
  - VOL=1.0 で従来通り、0.0 で完全 mute、>1.0 で boost
  - WET 上げ + Q resonance peak でアンプ前段に過大入力 → アンプ歪み暴走を回避するため
- **`setAutoFilterVol(v)`** function 追加
- **`saveSoundSettings` / `loadSoundSettings` の slider id 配列に `'snd-af-vol'` 追加**

### Why
- urinami「これパラレルやってるので wet としておいて。Vol もつけよう。アンプの前に入るんだから滅茶苦茶歪んでしまう」(2026-04-27)
- WET は wet/dry mix (effect の濃さ)、VOL は post-mix の総量 trim (アンプへの入力レベル) で意味が違う

### BREAKING なし
- consumer 側で `snd-af-vol` slider 未追加でも default 1.0 で従来動作


## [2026-04-27] {pending-sha} — autoFilterWet 追加 (Envelope Filter wet/dry mix)

### Feature
- **`autoFilterWet` (0-1, default 1.0) + true wet/dry chain** in `audio-effects.js`:
  - 新 chain: `tremoloNode → autoFilter → autoFilter2 → autoFilterWetGain ─┐`
              `tremoloNode ─────────────────→ autoFilterDryGain ────────┴→ autoFilterMix → phaser/dry mix`
  - WET=0 で完全 bypass (Envelope Filter 無効と同等の dry signal)、WET=1 で従来 series 通り
  - 中間値で wet/dry crossfade (linear: dry = 1 - wet)
  - urinami「Envelope Filter かかりすぎる、レゾナンスで歪む」への対応 (画像 #17)
- **`setAutoFilterWet(v)`** function 追加 (consumer は両 gain を直接触らずこの setter 経由)
- **`saveSoundSettings` / `loadSoundSettings` の slider id 配列に `'snd-af-wet'` 追加** + 旧 `'snd-af-level'` からの migration

### Why
- urinami 観察: AMP Vintage Envelope Filter の AUTO FILTER ON 時に effect 強度が強すぎる、Q resonance で歪む
- 単純な output gain では dry signal も attenuate されるので、parallel wet/dry mix が正解 (urinami「これパラレル？」「level じゃなくて wet では」)

### BREAKING なし
- consumer 側 (keys / 64PE) で `snd-af-wet` slider を index.html に新規追加すれば反映、未追加でも default 1.0 (full wet) で従来動作
- 旧 `snd-af-level` localStorage キーは load 時に `snd-af-wet` へ自動 migration


## [2026-04-27] {pending-sha} — 'Rhodes Suitcase Vintage Wah' → 'Vintage Envelope Filter' rename

### Fix
- preset key / label を `'Rhodes Suitcase Vintage Wah'` → `'Rhodes Suitcase Vintage Envelope Filter'` に rename
  - urinami 観察: Wah ではなく Envelope Filter (auto-filter envelope follower) が正確 (画像 #17)
- `audio-persistence.js loadSoundSettings` に migration: 旧 'Wah' キーは新 'Envelope Filter' に置換 (旧 localStorage 値の救済)

### BREAKING なし
- 直前 commit 6d6921c で追加された preset の rename、外部公開前の修正
- consumer 側 displayRename map も同 rename


## [2026-04-27] {pending-sha} — AMP Vintage Wah preset 追加 (urinami 指示、HPS gate)

### Feature
- **`'Rhodes Suitcase Vintage Wah'` preset 追加**:
  - `EP_AMP_PRESETS` に新 entry (epiano-engine.js)、`_SUITCASE_COMMON` 流用で useCabinet:true (HPS gate)
  - `ENGINES.epiano.presets` に新 entry (audio-engines.js)、label: 'Pad Sensei MK1 Suitcase Vintage Wah'
  - voicingLabDefaults は Vintage 流用 (urinami 後で実機 voicing 確定 → 別 commit で焼き込み予定)
  - Wah 効果自体は consumer 側 (64PE autoFilter BP) で実装、本 preset は preset key + voicing baseline のみ提供

### Why
- urinami 「Wah が掛かってるもの」 = AMP Vintage 派生。「私が作ってないのに入れたらいかん」 → voicing 確定は urinami が後で実施、preset key と HPS gate のみ先行追加

### BREAKING なし
- 既存 4 preset 不変、新 entry の追加のみ
- consumer (keys / 64PE) 側 display rename map に 'Rhodes Suitcase Vintage Wah' → 'Pad Sensei MK1 AMP Vintage Wah' を追加


## [2026-04-27] {pending-sha} — Reverb TYPE / Bass / Treble 永続化 P2 fix (Codex 監査)

### Fix
- **`_loadEpMixer` reverbType 復元の change dispatch を撤去** (P2-1)
  - change handler が `_saveEpMixer` を呼ぶと、Keys fallback (mixer-ui.js) が host-only fields (rhodesLevel / tremolo) を default 値で serialize し、後続の `_loadKeysEpMixerExtras` が restore する値を破壊する bug を回避
  - 代わりに DOM 値直接 set + `_updatePlateRouting()` 直接呼出 + `epianoWorkletUpdateParams({useSpringReverb})` 直接送信
- **`audio-overlay.js dismissAudioOverlay` に worklet init 後 reverbType 再送 hook 追加** (P2-2)
  - `_loadEpMixer` が走るのは worklet init 前なので、その時点の `epianoWorkletUpdateParams` は no-op
  - worklet init 直後に EpState.reverbType / tonestackBass / tonestackTreble を worklet に再送

### Why
- Codex 監査 P2 指摘 (前回 commit 8df8779 へのレビュー)
- 復元シーケンスで他 host-only fields が破壊される可能性 (P2-1) と、worklet 反映が起動時に効かない問題 (P2-2)

### BREAKING なし
- 既存 schema 不変、consumer 側 adapter 変更不要


## [2026-04-27] {pending-sha} — _saveEpMixer / _loadEpMixer に Reverb TYPE / Bass / Treble 永続化追加

### Fix
- **`_saveEpMixer` の payload に `reverbType` / `tonestackBass` / `tonestackTreble` 追加**
  - urinami 報告: UI で Plate に切替えても次回起動時に preset default (= spring) に戻る既知 bug。Bass / Treble も同様に未保存
  - 修正: 3 フィールドを localStorage `*-ep-mixer` (consumer 側 key prefix) に永続化
- **`_loadEpMixer` の restore に上記 3 フィールド追加**
  - EpState への書き戻し
  - bridge mixer.syncSliders / syncValueLabels で ep-eq-bass / ep-eq-treble の DOM 値・label を同期 (slider 0-1 → label v*10)
  - ep-reverb-type は DOM dropdown 値を直接反映 + change event dispatch (worklet routing 切替を確実発火、epianoWorkletUpdateParams `useSpringReverb` ignore 経路への対応)

### Why
- pad-sensei-keys / 64-pad-visualizer 両 consumer で urinami が「Plate 選んでも保存されない」「Bass/Treble も次回起動で戻る」と観測
- audio-core 側で永続化 schema を統一する方が host adapter 個別実装より clean

### BREAKING なし
- localStorage に新 field 追加するだけ (旧 key 互換維持)
- consumer side の adapter 変更不要 (saveEpMixer / loadEpMixer bridge の payload に新 field が増えるが key access のみ)

### 関連
- 同 commit に 2026-04-27 rebuildFilterChain MasterTail hook も含む (separate entry below)


## [2026-04-27] {pending-sha} — rebuildFilterChain に MasterTail hook (host-side master tail 共通経路)

### Feature
- **`rebuildFilterChain` の chain 終端**を `window.MasterTail.input` 優先に変更
  - host が `window.MasterTail` を提供すれば chain 終端は `MasterTail.input` (例: bassFilter) に向き、tail (bass/treble + masterTrim 等) を経由して destination に到達
  - host が未提供なら従来通り `audioCtx.destination` 直結 = 後方互換 (smoke test / legacy consumer 不変)
- **`window.rebuildFilterChain` を expose**: host が MasterTail 後付け init した時、再構築の trigger として呼べる

### Why
- pad-sensei-keys 側で host-side master tail (Bass/Treble 全 preset 共通 + 固定 +3dB) を実装済 (commit 118a570)
- これを 64Pad Explorer に移植する際、64PE は loCut/hiCut UI が現役で `rebuildFilterChain` 呼出経路がある → host 側で `masterBus.disconnect(destination)` で挿入する keys 方式が競合
- 解決: audio-core 側 chain 構築の終端を host MasterTail に渡せる hook 構造に変更、両 consumer 共通経路化

### Consumer side
- **BREAKING なし**: MasterTail 未提供なら従来 destination 直結
- keys は次回 bump 時に `master-tail.js` を rebuildFilterChain 経由型に改修推奨 (現状の `masterBus.disconnect(destination)` 方式から `MasterTail.input` を expose する方式へ。ただし現状 keys では rebuildFilterChain 未呼出なので動作影響なし)
- 64PE は host-tail 設置 + `MasterTail.init()` 後に `window.rebuildFilterChain()` を呼ぶ


## [2026-04-25] {pending-sha} — D-12 Step 2: PU 非線形ゾーン到達深さ調整 (bass 歪み生成)

### Feature
- **`tinePuPosBassDriveFactor(midi)`** 関数追加: bass の puPos peak を LUT 端寄りに押し込む per-key factor
  - midi <= 50 で 1.3x、midi 50-60 で taper to 1.0x、midi >= 60 で 1.0
  - 物理対応: 実機 Rhodes の per-pickup voicing (pole 形状 / 磁化分布 / 個別 gap voicing) と等価
- **`this.vPosScale[vi]` 計算式に乗算**: `vPosScale = (omega0/vA_fund) × tinePuPosBassDriveFactor(midi)`
  - puPos peak が bass で +30%、LUT 端 (qRange 0.45) 寄りへ
  - g'(q) の非線形飽和ゾーンに深く到達 → bass の歪み生成
  - LUT 端で saturate → 線形 gain は飽和で頭打ち、**「歪みだけ」増えて音量はほぼ不変**
- **`this.puPosBassDriveEnabled`** msg toggle 追加 (default true)
  - F-NEW と独立に on/off 可能、UI 側 `pupos-bass-drive-enabled` select で A/B 比較

### 設計判断
- vTineAmp の bass boost (modal 振幅段) は音量も増やすため **却下**
- vPosScale boost (LUT 入力段) なら **歪みのみ** 増えて音量保持 → 採用
- 物理対応: 実機 PU の voicing と直接対応、tine 自体の物理は不変
- bass-only 1.3x の理由: 1.4x で puPeak 0.4668 が qRange 0.45 を超え Drive/Vintage preset で過剰、1.3x で puPeak 0.4351 = 安全圏

### 測定 (Rhodes DI, velocity=1.0, F-NEW + Bass Drive 1.3x)
| Band | F-NEW のみ | + Bass Drive 1.3 | Δ THD |
|---|---|---|---|
| bass E1-E2 | THD -7.85 / puPeak 0.34 | **THD -6.35 / puPeak 0.4351** | **+1.50 dB の歪み増** |
| low/trans | THD -8.46 / puPeak 0.32 | THD -7.64 / puPeak 0.38 | +0.82 |
| mid C3-C4 | -9.50 / 0.30 | -9.50 / 0.30 | 不変 |
| treble C5+ | -22.73 / 0.10 | -23.66 / 0.10 | 不変 |

### 耳判定 (うりなみさん, 2026-04-25)
- 1.4x: 「Drive や Vintage だと歪む」(過剰)
- **1.3x: 「感じは出ている」 → 確定**
- mid の歪み残: voicing layer (Tone Balance / Suitcase Baxandall EQ) で別途カット予定

### D-12 物理レベル完成
- F-NEW (bass +4 dB の音量増、磁化体積 A_tine ∝ L) + Bass Drive (bass 歪み生成、PU 非線形飽和) で D-12 完成
- 残課題: voicing layer の整理 (mid cut、preset 横断 Bass/Treble UI、treble 別 voicing)

### 派生原則
- 物理層 (F-NEW + Bass Drive) と voicing 層 (EQ / Tone Balance) を構造で分離
- UI は「実機 rigid な再現」より「使いやすさ」を優先 (preset 横断の共通コントロール)
- 詳細: memory `project_pad_sensei_modeling_rationale` の三層 ground truth (音色 / 配布 / 使いやすさ)

### Verification
- node --check PASS
- baseline 再測定で bass 歪み生成・音量ほぼ不変・mid/treble 不変を確認


## [2026-04-25] {pending-sha} — D-12 F-NEW: 磁化体積項 A_tine ∝ L で bass-only +4 dB

### Feature
- **`tineMagneticVolumeFactor(midi)`** 関数追加: EMF = B × A_tine × dΦ/dt の A_tine 項
  - bass tine の物理磁化量 (L が長い → 磁化された steel volume 大) を EMF 経路に反映
  - 物理根拠: 実機 Rhodes DI でも bass がそれなり大きいという耳判定事実の物理説明
  - bass-only boost (`Math.max(L/L_ref, 1.0)`): bass +0〜+5 dB、mid 不変、treble 不変
  - L_ref = tineLength(59) = B3 reference
- **`this.vMagFactor[]` per-voice array** 追加 (Float32Array MAX_VOICES)
  - noteOn で `tineMagneticVolumeFactor(midi)` を保存 (`fNewEnabled` toggle で 1.0 切替)
- **process loop で puOut に乗算** (vertical + horizontal 2 箇所)
  - `puOut = gPrime × tineVelocity × vVelScale × vTipFactor × vMagFactor × puEmfScale`
- **`this.fNewEnabled`** msg toggle 追加 (default true)
  - 旧モデル相当の音と A/B 比較可能 (UI 側 `f-new-enabled` select)

### 測定 (Rhodes DI, velocity=1.0, Ableton 表記)
| Band | F-NEW Off (旧) | F-NEW On (新) | Δ |
|---|---|---|---|
| bass E1-E2 | -25.86 dB | **-21.80 dB** | **+4.06 dB** ↑ |
| low/trans C2-C3 | -24.49 | -22.42 | +2.07 |
| mid C3-C4 | -21.66 | **-21.67** | ~0 (元のまま) |
| treble C5+ | -37.21 | **-36.83** | ~0 (元のまま) |

→ bass +4 dB の boost、treble の副作用ゼロ、mid 不変。実機 Rhodes 「DI でも bass がそれなり大きい」に近づいた。

### 耳判定 (うりなみさん, 2026-04-25)
- 「ベースは太くなっている」「これでいい」(F-NEW v2 floor 1.0 適用後)
- bass 音量は **完成**判定
- treble は別途 voicing 調整で対応 (実機 PU の per-pickup 微調整)
- 歪み感は別途追加予定 (Step 2: vPosScale bass-drive)

### Verification
- node --check PASS
- baseline 再測定で bass-only +4 dB / treble unchanged 確認

### Related
- 物理根拠: `notes/permanent/2026/DIでもPU非線形のg'(q)非対称クリップでbassのpassive saturationは生成される`
- memory: `urinami_rhodes_real_instrument_experience` (整備済実機 + Vintage Vibe voicing reference)


## [2026-04-25] {pending-sha} — D-12: コメント整合性監査と書き直し (29 件、コード機能不変)

### Audit
- 4 並列 agent で全 3535 行のコメントを実装と照合監査
- BLOCKER 12 件 + MAJOR 17 件 = 29 件の乖離を発見
- 支配的パターン: 「state allocated → noteOn 書き込み → process loop で読まれない or msg path 削除済 → コメントは『効いている』」
- 詳細: `デジタル百姓総本部/プロジェクト/PAD DAW/audits/d12-baseline-2026-04-25/comment_audit.md`

### Fix (コメントのみ、コード変更なし)
- escapement clamp 嘘 (L408-409): clamp は 2026-04-07 disabled 済、抑制経路は velScaled DR + LUT qRange と訂正
- A4 forte 数値ずれ: 0.3 → 0.12 (2026-03-25 SSOT) に更新
- hallMassCorrection / alphaScale / vDecayHoldoff / vPuDampStrength / tremoloShape / preampGain 等 dead state を「dead 宣言 + 経緯 + Re-enable 条件」フォーマットで整理
- sqrt mechanical advantage コメント: D-1 線形化済を明記
- escapement「8× variation」: 実装は avg-to-avg の 5× ratio に訂正
- 「2x oversampled, halfband」: 実装は 2-tap 平均、proper halfband ではないと訂正 (3 箇所: lutLookup2x / Ge preamp / Ge poweramp)
- Σ V_n² = 1 energy 保存: massScale 倍で絶対 energy 保存していない事実を明記
- beam dB 表記: -15/-25 → -12/-18 (実装定数 BEAM_ATTACK_CLAMP=0.25 / BEAM_SUSTAIN_CLAMP=0.12) に整合
- whirl / coupled tonebar: default OFF + 現状音 OK の事実を明記
- damper impact ∝ velocity 偽装: 実装は envelope amplitude と訂正
- damper Layer 2/3: SCALE=0.0 で disabled、Layer 1 (thud) のみ active と明記
- sendSum: Twin removed で dead bus、post_tremolo placement は機能していないと明記
- Suitcase finalOutputGain 「2x」: 単独では Stage 0.7 vs 0.5 で逆、Voicing Lab 込みで Stage 比 約 3.4x と明記
- spring diag mute / 旧 HPF コメント残存 / アーキテクチャ図 Tremolo 位置 / Match condition / vPosScale 領域記述 等を実装に整合
- computePreampLUT_Ge: dead function 宣言、active chain は computePreampLUT_Si2N3392_2stage と明記

### Verification
- node --check PASS
- D-12 baseline 再測定: 全 band で ±0.5 dB 以内の差 (random fluctuation 範囲) を確認、機能不変
- うりなみさん耳判定 (2026-04-25): 7 つの音色項目について A/B 試験で「現状 OK」と確定 (escapement 破裂感無し / beam dB ちょうど良い / energy 均等 / whirl 自然 / coupled TB OK / release キャラ OK / sendSum UI 露出無し)

### 派生 issue (別セッション)
- release inharmonicity 増加 (理想方向、urinamiさん明言)
- L1247-1264 computePowerampLUT_Ge は active な誤コメント (Peterson 80W = 2N0725 Si BJT、Ge ではない) — Phase 5 Ge→Si rename で対応予定

### Related
- audit ノート: `audits/d12-baseline-2026-04-25/comment_audit.md`
- 書き直し統合: `audits/d12-baseline-2026-04-25/comment_rewrites.md`
- baseline: `audits/d12-baseline-2026-04-25/baseline.md`
- memory: `project_pad_sensei_modeling_rationale` (物理モデリングは目的ではなく手段)


## [2026-04-23] 9d7d857 — D-1: velScaled 線形化 (DR 3→18 dB 改善、物理に忠実化)

### Feature
- `computeTineAmplitude` の A_raw を `√velScaled` から `velScaled` 線形に変更
- 物理根拠: hammer → tine 運動量伝達は v_hammer に線形、A = v_tine/ω も線形

### 測定 (velocity 0-1 正規化、drive=5.0、urinami v1 voicing)
| Note | MIDI | old (sqrt) | D-1 linear | Δ |
|------|-----:|----------:|-----------:|---:|
| E1 | 40 | 7.8 dB | 15.5 dB | +7.7 |
| C4 | 60 | 5.0 dB | 17.8 dB | +12.8 |
| E3 | 64 | 3.8 dB | **18.4 dB** | +14.6 |
| C6 | 84 | 3.2 dB | **18.4 dB** | +15.2 |

### 副次発見 (根本的ミス)
- 従来の per-key 音量測定 spec は `noteOn(midi, 110)` で **raw MIDI 0-127** を渡しとった
- worklet は 0-1 期待 (keyboard.js: `noteOn(midi, 0.8)`)
- 旧 sqrt が 11x 増幅を partially mask していたため「動く」ように見えとった
- **全 A/B 試行 (per-key 逆U字) は saturated state で測定されとった可能性高い**

### Consumer
- A_raw の変化: v=1.0 で同じ、v<1 で物理的により静か (pp→ff レンジ拡大)
- 絶対音量は ff ほぼ同等、pp はより小さく聞こえる
- makeup gain / Tone Balance 再調整が必要な場合あり

## [2026-04-23] b03274f — B-2 revert (urinami 耳判定「低音が弱いという印象しかない」)

### Revert
- `computeTineAmplitude` の `A_raw *= tipMassFactor` 乗算を無効化（コメントアウト）
- `TUNING_MASS_G` テーブル / `tuningMassKg()` / `m_eff` / `tipMassFactor` 計算は**保持**（C 軸で再組み込み可能な形）

### 背景
- 56c0567 で物理的に正しい tuning mass 補正を統合、Gemini 外部レビュー PASS
- しかし urinami 耳判定: 「低音が弱いという印象しかない」→ 音色で net 負
- 方針: 「音色でやって物理を探せるのが理想。無理なら耳優先」(urinami 2026-04-23)
- 永続ノート [[物理モデリングの優先順位は物理の構造ではなく知覚の重み付けで決まる]] と整合

### 残っている認識
- 物理モデルとしては B-2 は正しい (m_tip が重い bass の displacement は √(m) で減衰)
- 単独では逆U字を悪化させるだけ → C-1 (qRange 物理幾何) + C-2 (LUT 正規化 rework) と**同時**でないと意味を持たない
- 次の実装時に再有効化の判断をする

### Consumer 対応
- B-2 乗算無効化で、23f81cc 以前 (0d5dc82) の挙動に戻る
- API 変更なし

---

## [2026-04-23] 56c0567 — B-2: FDTD tuning mass (88 keys) を DSP に統合 (treble 逆U字尾部を +1-2 dB 改善)

### Feature
- **B-2**: `computeTineAmplitude` に per-key tip tuning mass 物理を追加。`TUNING_MASS_G` (Float32Array 128) を埋め込み、`tuningMassKg(midi)` 経由で m_eff = m_beam_eff + m_tip を計算、`tipMassFactor = √(m_eff_A4 / m_eff)` を A_raw に乗算 (A4 固定 → tineScale 保持)
- 出典: `tools/fdtd_output/tuning_mass_88_nes.json` (2026-03-26 FDTD inversion, NES coupling) — sync miss していた物理軸を取り込み

### 測定 (vs no-factor baseline, vel=110, Suitcase + urinami v1)
- C1 (24): **−2.47 dB**  (m_tip=8.7g, 極低音の重い tip mass が displacement を減らす物理通り)
- E1 (40): +0.92 dB
- E2 (52): −0.63 dB
- C4 (60): −0.95 dB
- E3 (64): −0.16 dB
- C5 (72): +0.24 dB
- C6 (84): **+0.97 dB**
- E5 (88): **+2.10 dB**

### 評価 (部分的勝利)
- **高音側 inverse-U 尾部 HELPED**: C6/E5 が +1-2 dB (狙い通り)
- **極低音 HURT**: C1 が −2.5 dB (物理通りだが体感の逆U字悪化)
- **中音 slight reduction**: C4 −1 dB, E3 −0.2 dB (狙い通り、peak 下げ)
- 物理的には正確。残りの逆U字は PU + amp パイプライン由来 (bass displacement は大きいが低周波は dΦ/dt が小さい)

### 次の軸
- C1 (m_tip=8.7g) の物理的減衰は tuningMassFactor 単独で補正不可 → urinami 方針通り、ダメなら LUT 近似へ
- 実測に合わせた combined 係数による LUT approximation (urinami 2026-04-22 明言)

### Consumer 対応
- API 変更なし、A_raw 内部挙動のみ。default で有効
- 既存 consumer (64PE / MRC) は bump で per-key 音量バランス変化を体感確認

---

## [2026-04-23] 8969774 — A-1 lhorOffset feed + A/B 試行履歴コメント追記 (音量逆U字解消は情報不足で不可能と確定)

### Fix
- **A-1**: `puLutParams` に `lhorOffset` 引数追加、`KEY_VARIATION[midi*3+1]` を feed (Codex 2026-04-07 sync miss 解消)。効果 ±0.1 dB、per-key random individual variation として保持 (物理モデル正確化)
- `computePickupLUT` / `computePickupLUT_dipole` / `computePickupLUT_horizontal` 全 3 関数に pass-through

### Doc (未実装の試行履歴コメント)
- `puGapMm` に A-2 試行履歴追記 (0.60/0.80/0.85/0.90mm 測定、音量差 ±0.3 dB、v2 1.1mm taper に revert)
- `computeTineAmplitude` の `* 0.12` に A-4 試行履歴追記 (per-key 0.12-0.18 curve、両端 +0.8-1.0 dB、peak 副作用、0.12 固定 revert)
- `qRange` 近傍に A-3 試行履歴追記 (pow 0.8、両端 +0.7-0.9 dB、pow 0.15 revert)
- 3 LUT 関数の normalize に B-1 試行履歴追記 (per-key max(|lut|)、逆効果 -3〜-4 dB、固定 refPeak revert)

### 背景 (Codex/Gemini 外部監査 2026-04-23 + urinami 方針)
- PU 前段 (gap/qRange/tineScale/lhorOffset/alphaNorm) の per-key 調整では音量逆 U 字解消不可 (A-1〜A-4 + B-1 完全潰し)
- PU 磁力 absolute 不明 + hammer 材質粘弾性不明 + spring mass 情報不足で原理的に不可能
- 詳細: [[notes/permanent/2026/Rhodes物理モデリングの音量逆U字はPU前段のper-key調整では解消できずLUT正規化が rate-limiting である]]
- phase-0 trials log: `プロジェクト/PAD DAW/phase-0_per-key-amplitude-trials-2026-04-23.md`

### 次の軸 (未実装)
- `tools/fdtd_output/tuning_mass_88_nes.json` に FDTD 計算済み per-key tuning mass 存在、**DSP 未組み込み** (次 commit で実装予定)

### Consumer 対応
- A-1 lhorOffset feed は既存 consumer (64PE / MRC) 影響なし (default undefined で従来動作)
- 試行コメント追記のみ、機能変更なし


## [2026-04-23] ac44244 — Phase 4 J-A wet/dry blend 配線 (jaWetMix default 0 = bypass)

### Feature
- `this.jaWetMix` state を worklet constructor に追加 (default 0 = 完全 bypass、旧 `if (false)` と同等)
- `if (false)` で封印していた J-A hysteresis 処理本体を `if (this.jaWetMix > 0.001)` で条件分岐化
- dry/wet blend 処理を追加: `ampSig = dryForJA * (1 - jaWetMix) + wetJA * jaWetMix`
  - jaWetMix=0 で target 2026-04-23 状態と完全一致
  - jaWetMix=1 で full J-A (pre/de-emph LowShelf 200Hz ±6dB + Langevin hysteresis)
- `_updateParams` に `msg.jaWetMix` 受け口 (clamp 0-1)
- `_epwSendVoicingLabParams` に jaWetMix 伝播
- `_epwSendParams` が window.EpVoicingLab.jaWetMix を同梱送信

### 背景 (保留扱い)
Phase 4 T1 J-A は「Suitcase amp 内の低音飽和」を担う。urinami 2026-04-23 明言「Stage で低音が小さいのはアンプの問題ではない、物理の問題」で、**Stage の低音ファット感問題は PU 段 (tine amplitude + 非線形 LUT)** が本丸と再確認された。Phase 4 は Suitcase 向けであり Stage の低音問題を直接解決しない。

実装は default=0 で完全 bypass なので consumer 影響なし。urinami さんが後日 Voicing Lab の J-A MIX slider を上げて試せる状態で保持。

### Consumer 対応
- default jaWetMix=0 で旧動作と完全一致
- window.EpVoicingLab.jaWetMix を設定しない consumer (64PE / MRC) は影響なし

---

## [2026-04-23] 58a268b — Voicing Lab 配線: worklet param 口 + debug hook

### Feature
- `this.suitcasePreFxTrim` state を worklet constructor に追加（default 0.42）
  - 旧: `ampSig = drySum * this.rhodesLevel * 0.42`（hard-coded 定数）
  - 新: `ampSig = drySum * this.rhodesLevel * this.suitcasePreFxTrim`（可変）
- `_updateParams` に Voicing Lab 3 パラメータ受け口を追加:
  - `msg.gePreampDrive`（clamp ≥ 0.1）
  - `msg.gePreampGain`（clamp ≥ 0.01）
  - `msg.suitcasePreFxTrim`（clamp ≥ 0.01）
- `_onMessage` に `_debugDumpVoicing` hook 追加 — worklet 内の実 voicing 値を main thread に返す（検証・パイプライン診断用）
- `_epwSendVoicingLabParams(params)` を main thread 側 (epiano-worklet-engine.js) に新設、`window._epwSendVoicingLabParams` で expose
- `_epwSendParams` が呼ばれる度に `window.EpVoicingLab` の値を worklet に同梱送信（preset 切替等で reset されない）

### Consumer 対応
- Voicing Lab は keys 検証ツール限定。64PE / MRC / Plugin は `window.EpVoicingLab` を設定しなければ worklet default (2.5 / 1.5 / 0.42) で動作
- API 追加のみで既存 consumer への影響なし

### 背景
urinami 2026-04-22「makeup gain 下げて歪ませる = saturator 的に drive を増やす」仮説を耳で A/B 検証するため。Phase 1 Si 2N3392 LUT の voicing 3 値をコード定数から外し、実時間 UI 調整を可能化。

---

## [2026-04-22] ff8eb6c — Phase 1: Peterson Suitcase preamp Si 2N3392 2-stage topology 訂正

### Feature
- `computePreampLUT_Si2N3392_2stage()` 追加（engine + worklet 両方）— Peterson 80W schematic fig11-8 精読結果を反映した Si NPN 2 段 CE カスケード
- 関数形: `y = x / (1 + |x|^n)^(1/n)` smooth saturator、`nPos=2`（positive soft knee = Vce_sat 方向飽和）、`nNeg=3`（negative hard knee = cutoff 方向）、2 段カスケードで小信号 linear + 大信号で累乗的圧縮
- `preampType === 'Si2N3392_2stage'` を engine 側 preamp LUT dispatch に追加
- Worklet に test hook: `_debugDumpPreampLUT` message → `_debugPreampLUT` で内部 LUT を main thread に dump（Playwright contract test 用）
- Phase 1 E2E 測定 spec `tests/e2e/phase1-preamp-thd.spec.js` 新設（5 test all PASS、M1-M6 測定プロトコル準拠）

### Fix (topology 訂正)
- Peterson 80W Suitcase Preamp: 旧 `'NE5534'`（op-amp 単段モデル）を `'Si2N3392_2stage'` に置換。schematic fig11-8 Q1/Q2 は 037118 selected 2N3392 Si NPN 2 段 CE であり、NE5534 は誤認だった
- Worklet 側 `this.gePreampLUT` 初期化を `computePreampLUT_Ge()` → `computePreampLUT_Si2N3392_2stage()` に訂正。Peterson は Germanium ではなく Silicon（永続ノート参照）
- AB763 Hi input `-6dB` divider（68k/68k voltage divider）を `preampType === '12AX7'` 限定に絞った。Peterson fig11-8 にこの divider は存在しない（Codex 監査 round 2 指摘）

### Voicing 残件（urinami 聴感 A/B 調整領域、Phase 1 topology 範囲外）
- Worklet chain 側 `drySum * rhodesLevel * 0.42 * gePreampDrive(2.5) * gePreampGain(1.5)` の voicing 係数
- Fallback engine 側 `preampMakeup = 1.0` の Si 化補正

### Consumer 対応
- 変数名 `gePreampLUT` は互換維持（Phase 5 で poweramp 訂正と同時に `ge*` → `si*` rename 予定）
- Phase 1 は preamp のみ。Poweramp は引き続き `computePowerampLUT_Ge()`（Phase 5 で 2N0725 Si push-pull direct-coupled OCL に訂正予定）
- Consumer（64PE / Keys / MRC / Desktop）は submodule pointer を bump すれば自動反映

### Measured
- 1kHz @ out RMS -40 dBFS: THD = -90 dB（criterion <-50dB、margin 40dB ✓）
- 1kHz @ out RMS -10 dBFS: THD = -32 dB（criterion >-34dB、margin 2dB ✓）
- 8kHz vs 1kHz gain diff: 0 dB（criterion <3dB ✓）
- Worklet ↔ fallback LUT numeric match: maxDiffNorm = 6.6e-8（両 path 同一 shape ✓）

### Ref
- 永続ノート: [[Peterson 80W Suitcase の Power Module は Si BJT push-pull direct-coupled OCL 構造で Germanium でも output transformer でもなく interstage transformer T1 のみを持つ]]
- Plan: `デジタル百姓総本部/プロジェクト/PAD DAW/Suitcase_amp_modeling_plan_2026-04-22.md` v9 §Phase 1
- Codex 監査 5 ラウンド通過

---

## [2026-04-22] a5fff53 — preset output compensate + Suitcase cab LPF 5.5kHz + gain chain simplify

### Feature
- `EP_AMP_PRESETS[*].outputGainDb` metadata 追加（DI=+6dB, Suitcase=0dB）
- `audio-master.js` に `_epOutputCompensate` GainNode 新設（masterBus 直前に挿入）
- `audio-engines.js` `_applyPresetOutputGain()` 追加 — preset 切替時に dB→linear で compensate gain を `setTargetAtTime(30ms)` 適用
- Debug hook: `window._DEBUG._epOutputCompensate` / `window._DEBUG.masterBus`（Playwright 実測用）

### Fix
- Suitcase cabinet LPF cutoff `4000 → 5500 Hz`（Eminence Legend 1258 sealed-box -6dB point 実測値に合わせ、urinami 2026-04-22「上が出なさすぎる」修正）
- `epianoDirectOut` / `epianoAmpOut` 初期 gain `0.49 → 1.0`（slider 初期値の歴史的残骸を除去、マスター VOL は `masterBus` が単独制御）

### Routing
- DI chain (`flangerMix`) / Suitcase amp out (`epianoAmpOut`) / Plate reverb return (`ePlateReturn`) が **masterBus 直結から _epOutputCompensate 経由に変更**
- 目的: 物理モデル内部挙動を変えずに preset 間音量揃えを最終段でのみ補正（urinami 2026-04-22 設計方針）

### Consumer 対応
- 64PE / Keys / MRC など consumer は、新 GainNode `_epOutputCompensate` を参照する必要はない（既存の masterBus 連携はそのまま動作）
- preset 切替時の音量補正挙動は自動有効化。Opt-out 不要

---

## [2026-04-16] 3acbd6c — schemaVersion minor warn + CHANGELOG-enforcing hook（Plan C）

### Feature
- `validateAudioCoreConfig()` に minor mismatch 検出を追加
  - host `schemaVersion` の minor 部分が `REQUIRED_SCHEMA_MINOR` と違えば `console.warn`（throw せず動作継続）
  - 例: host=`1.1`、required=`1.0` → warn だけ出て機能差異を通知
- `tools/pre-commit.sh` + `tools/install-hooks.sh` 新規 — *.js / INTERFACE.md 変更時に CHANGELOG entry 必須を機械化
  - Scope: `*.js` + `INTERFACE.md`（README.md / typo はノイズ源なので除外）
  - Bypass: `SKIP_CHANGELOG=1 git commit ...`
  - Install: `./tools/install-hooks.sh`（clone 直後に 1 回、各 clone で別途）

### 動機
Codex Plan A Final audit (reports/20260415-221118-design.md) CONFIRM 2 (minor mismatch warn 未実装) + MINOR 1 (CHANGELOG hook 未実装) の吸収。urinami 原則「構造で記憶を外化」に従い、contract の doc-only 管理から runtime + git hook の二重防御へ。

---

## [2026-04-15] 0fb3e7b — schemaVersion strict gate + INTERFACE.md（Plan A、Codex BLOCKER 3）

### BREAKING
- `audioCoreConfig.schemaVersion` を **必須化**。`audio-master.js` 起動時に検証。
  - missing / NaN / non-number / major mismatch → **throw**
  - minor mismatch: 現時点は throw なし（minor 機能は将来 `REQUIRED_SCHEMA_MINOR` 導入時に warn、TODO 参照）
- 全 consumer は `audioCoreConfig.schemaVersion: 1` を設定すること。
  - 64PE: `host-adapter.js` で per-key defensive merge（既存 mergeDefaults pattern と同思想）
  - Keys: `app.js` の object literal に直接記述
  - 将来 Effects / Desktop / VST/AU wrap も同様

### Feature
- `audio-core/INTERFACE.md` 新規 — schema contract SSOT、変更時手順、consumer 実装例

### 動機
Codex 監査（2026-04-15、reports/20260415-171910-design.md）BLOCKER 3:「audioCoreConfig 契約は文書のみで機械的 gate なし」→ adapter 追加/削除時に Claude が no-op で起動して「動くが一部だけ壊れている」事故を見逃す。**urinami 原則「構造で記憶を外化する」**に従い、CHANGELOG 文書だけでなく runtime throw で強制。

---

## [2026-04-15] {baseline} — CHANGELOG 運用開始

### Feature
- host-decoupling refactor 完了（Phase 3.0.a-f、8 commits）
  - `window.audioCoreConfig` 7 sub-interface（velocity / midiBridge / presetDropdown / persistence / muteUI / mixer / overlay）
  - `audio-core/assets/` 配下に FDTD data と twin-cab-ir.wav を移設
  - `AUDIO_CORE_BASE` global で asset path 柔軟化
- Pad Sensei Keys standalone（`~/pad-sensei/keys/`、旧 `~/pad-sensei-mk1-standalone/`）を consumer として追加

### Fix
- Volume routing single merge point（masterBus 一点制御）— 旧: masterGain / epianoDirectOut / epianoAmpOut 分散制御で volume 0 でも音が出る bug
- `_loadEpMixer` の 6-slider 同期漏れ
- `_applyPresetEpMixerDefaults` の preset default 値反映漏れ

### 既知の consumer pointer 状態（2026-04-15 時点）
- 64PE Web: 最新を参照
- MRC: 旧 pointer（C 固定モード未対応）、bump 判断は plan v5 §Operational §3 参照
- Pad Sensei Keys: 最新を参照

### 今後の TODO
- ~~`audioCoreConfig.schemaVersion` field 未実装~~ → 2026-04-15 実装済（上記 Plan A entry 参照）
- cross-consumer CI（audio-core push → 64PE/Keys/MRC の test trigger）未実装
- `REQUIRED_SCHEMA_MINOR` 導入（minor mismatch → console.warn）— 将来必要になったら追加
