const fs = require('fs');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  const messages = [];
  let resolveModule;

  class FakeAudioWorkletNode {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (message) => messages.push(message),
      };
    }
    connect() {}
  }

  const context = {
    console,
    AudioWorkletNode: FakeAudioWorkletNode,
    fetch: () => Promise.reject(new Error('fixture: no FDTD assets')),
    window: { APP_VERSION: 'test', AUDIO_CORE_BASE: 'audio-core/' },
    EP_AMP_PRESETS: {
      'Rhodes DI': {
        preampType: null,
        powerampType: null,
        useTonestack: false,
        useCabinet: false,
        useSpringReverb: false,
      },
    },
    EpState: {
      preset: 'Rhodes DI',
      pickupSymmetry: 0.3,
      pickupDistance: 0.5,
      preampGain: 1,
      tonestackBass: 0.5,
      tonestackMid: 0.5,
      tonestackTreble: 0.5,
      brightSwitch: false,
      springReverbMix: 0,
      springDwell: 0,
      use2ndPreamp: false,
      cabinetGain: 1,
      tremoloOn: false,
      tremoloFreq: 4.5,
      tremoloDepth: 0,
    },
  };

  vm.createContext(context);
  const source = fs.readFileSync('epiano-worklet-engine.js', 'utf8');
  vm.runInContext(source, context);

  const audioCtx = {
    audioWorklet: {
      addModule: () => new Promise((resolve) => { resolveModule = resolve; }),
    },
  };
  const masterDest = {};

  // Real Push/Web startup can deliver CC64 before the first note creates the
  // AudioWorklet. That pedal state must survive bootstrap.
  context.epianoWorkletSetSustain(true);
  assert(messages.length === 0, 'pre-init sustain unexpectedly required a worklet node');

  const firstEnvelope = context.epianoWorkletNoteOn(audioCtx, 60, 0.8, masterDest, 1);
  assert(firstEnvelope && typeof firstEnvelope.cancel === 'function', 'first note did not return a cancellable envelope');

  // Also preserve a physical NoteOff that arrives while addModule() is pending.
  // Under sustain this must become noteOn -> noteOff at the DSP, not a lost cancel.
  firstEnvelope.cancel();
  resolveModule();
  await flushMicrotasks();

  const sustainOnIndex = messages.findIndex((m) => m && m.type === 'sustain' && m.on === true);
  const noteOnIndex = messages.findIndex((m) => m && m.type === 'noteOn' && m.midi === 60);
  const noteOffIndex = messages.findIndex((m) => m && m.type === 'noteOff' && m.midi === 60);

  assert(sustainOnIndex >= 0, 'sticky sustain was not replayed after worklet creation');
  assert(noteOnIndex > sustainOnIndex, 'first note reached DSP before sticky sustain state');
  assert(noteOffIndex > noteOnIndex, 'deferred first-note NoteOff was lost during worklet bootstrap');

  context.epianoWorkletSetSustain(false);
  const last = messages[messages.length - 1];
  assert(last && last.type === 'sustain' && last.on === false, 'pedal-up was not forwarded after bootstrap');

  console.log('worklet sustain bootstrap smoke: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
