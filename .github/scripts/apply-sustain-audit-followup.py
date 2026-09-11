from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'{label} anchor missing in {path}')
    p.write_text(s.replace(old, new, 1))


replace_once(
    'audio-voice.js',
    """    [..._sustainDeferredNotes].forEach(function(midi) {\n      const v = activeVoices.get(midi);\n      if (v && !v.engineHandlesSustain) _cancelVoiceNow(midi, v);\n      else _sustainDeferredNotes.delete(midi);\n    });\n""",
    """    [..._sustainDeferredNotes].forEach(function(midi) {\n      const v = activeVoices.get(midi);\n      // Deferred entries should only belong to non-worklet voices, but if state\n      // ever drifts, fail toward release rather than toward a stuck note.\n      if (v) _cancelVoiceNow(midi, v);\n      else _sustainDeferredNotes.delete(midi);\n    });\n""",
    'defensive pedal-up release',
)

replace_once(
    'CHANGELOG.md',
    "- `noteOffAll()` clears deferred sustain state.\n",
    "- `noteOffAll()` clears deferred sustain state and now schedules the same delayed saturation-node cleanup used by ordinary NoteOff, closing the previous all-notes-off resource leak.\n",
    'noteOffAll changelog',
)

Path('tests').mkdir(exist_ok=True)
Path('tests/sustain-voice-smoke.cjs').write_text(r'''const fs = require('fs');
const vm = require('vm');

function createHarness() {
  const cancellations = [];
  const workletSustain = [];
  const context = {
    console,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    document: { addEventListener: () => {}, getElementById: () => null },
    window: { addEventListener: () => {}, audioCoreConfig: null },
    masterGain: {},
    _soundMuted: false,
    ensureAudioResumed: () => {},
    _hidePadHint: () => {},
    triggerAutoFilter: () => {},
    saveSoundSettings: () => {},
    audioCtx: { state: 'running', currentTime: 0 },
    AudioState: { instrument: { epiano: null, sampler: null, data: {} } },
    _useEpianoWorklet: false,
    _ensureWafPlayer: () => true,
    wafPlayer: {
      queueWaveTable: () => ({ cancel: () => cancellations.push('waf') }),
      cancelQueue: () => {},
    },
    EP_AMP_PRESETS: { 'Rhodes DI': { useCabinet: false } },
    EpState: { preset: 'Rhodes DI' },
    epianoReverbSend: { gain: { setValueAtTime: () => {} } },
    epianoAmpOut: {},
    epianoDirectOut: {},
    epianoWorkletNoteOn: () => ({ cancel: () => cancellations.push('worklet-noteoff') }),
    epianoNoteOn: () => ({ cancel: () => cancellations.push('fallback') }),
    epianoWorkletSetSustain: on => workletSustain.push(on),
    AppState: { velThreshold: 0, velDrive: 0, velCompand: 0, velRange: 127 },
  };
  vm.createContext(context);
  const source = fs.readFileSync('audio-voice.js', 'utf8')
    + '\n;globalThis.__voiceTest={noteOn,noteOff,noteOffAll,setSustain,activeVoices,_sustainDeferredNotes};';
  vm.runInContext(source, context);
  return { context, api: context.__voiceTest, cancellations, workletSustain };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

{
  const { api, cancellations } = createHarness();
  api.noteOn(60, 0.8);
  api.setSustain(true);
  api.noteOff(60);
  assert(api.activeVoices.has(60), 'generic voice released while sustain was down');
  assert(cancellations.length === 0, 'generic envelope cancelled before pedal-up');
  api.setSustain(false);
  assert(!api.activeVoices.has(60), 'generic voice survived pedal-up');
  assert(cancellations.join(',') === 'waf', 'generic pedal-up did not cancel exactly once');
}

{
  const { api, cancellations } = createHarness();
  api.noteOn(61, 0.8);
  api.setSustain(true);
  api.noteOff(61);
  api.noteOn(61, 0.8);
  assert(cancellations.join(',') === 'waf', 'retrigger did not replace sustained voice');
  assert(!api._sustainDeferredNotes.has(61), 'retrigger left stale deferred release');
  api.noteOffAll();
  assert(api.activeVoices.size === 0 && api._sustainDeferredNotes.size === 0, 'noteOffAll left sustain state');
}

{
  const { context, api, cancellations, workletSustain } = createHarness();
  context.AudioState.instrument = { epiano: 'Rhodes DI', sampler: null, data: {} };
  context._useEpianoWorklet = true;
  api.noteOn(62, 0.8);
  api.setSustain(true);
  api.noteOff(62);
  assert(cancellations.join(',') === 'worklet-noteoff', 'worklet NoteOff was incorrectly deferred in host');
  assert(!api.activeVoices.has(62), 'worklet voice remained host-owned after NoteOff');
  assert(workletSustain.at(-1) === true, 'worklet sustain state not forwarded');
  api.setSustain(false);
  assert(workletSustain.at(-1) === false, 'worklet pedal-up not forwarded');
}

{
  // Defensive invariant: even if a future regression inserts an impossible stale
  // deferred entry for an engine-owned voice, pedal-up must release rather than stick.
  const { context, api, cancellations } = createHarness();
  context.AudioState.instrument = { epiano: 'Rhodes DI', sampler: null, data: {} };
  context._useEpianoWorklet = true;
  api.noteOn(63, 0.8);
  api._sustainDeferredNotes.add(63);
  api.setSustain(false);
  assert(cancellations.join(',') === 'worklet-noteoff', 'defensive stale deferred voice was not released');
  assert(!api.activeVoices.has(63) && !api._sustainDeferredNotes.has(63), 'defensive cleanup left stale voice state');
}

console.log('sustain voice smoke: PASS');
''')

Path('.github/workflows/test.yml').write_text('''name: Test audio-core\n\non:\n  pull_request:\n  push:\n    branches: [main]\n\njobs:\n  sustain-contract:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '22'\n      - name: Syntax + sustain behavior\n        run: |\n          node --check audio-voice.js\n          node tests/sustain-voice-smoke.cjs\n          git diff --check\n''')
