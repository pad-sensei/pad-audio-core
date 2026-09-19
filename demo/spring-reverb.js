const fileInput = document.querySelector('#audio-file');
const playButton = document.querySelector('#play');
const stopButton = document.querySelector('#stop');
const status = document.querySelector('#status');

const controls = Object.fromEntries(
  ['dry', 'wet', 'decay', 'drive'].map((id) => [id, document.querySelector(`#${id}`)]),
);

let audioContext = null;
let reverbNode = null;
let dryGain = null;
let wetGain = null;
let buffer = null;
let source = null;

function showValue(id) {
  document.querySelector(`#${id}-value`).value = Number(controls[id].value).toFixed(2);
}

async function ensureAudio() {
  if (audioContext) return;
  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule('../spring-reverb-processor.js');

  reverbNode = new AudioWorkletNode(audioContext, 'spring-reverb-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  dryGain = audioContext.createGain();
  wetGain = audioContext.createGain();

  dryGain.connect(audioContext.destination);
  reverbNode.connect(wetGain).connect(audioContext.destination);
  updateControls();
}

function updateControls() {
  for (const id of Object.keys(controls)) showValue(id);
  if (!audioContext) return;
  const now = audioContext.currentTime;
  dryGain.gain.setValueAtTime(Number(controls.dry.value), now);
  wetGain.gain.setValueAtTime(Number(controls.wet.value), now);
  reverbNode.port.postMessage({ type: 'setDecay', value: Number(controls.decay.value) });
  reverbNode.port.postMessage({ type: 'setDrive', value: Number(controls.drive.value) });
}

function stopPlayback() {
  if (!source) return;
  try { source.stop(); } catch {}
  source.disconnect();
  source = null;
  stopButton.disabled = true;
}

for (const control of Object.values(controls)) {
  control.addEventListener('input', updateControls);
  showValue(control.id);
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    await ensureAudio();
    buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    playButton.disabled = false;
    status.textContent = `${file.name} — ${buffer.duration.toFixed(1)}秒`;
  } catch (error) {
    status.textContent = `読み込み失敗: ${error.message}`;
  }
});

playButton.addEventListener('click', async () => {
  if (!buffer) return;
  await ensureAudio();
  await audioContext.resume();
  stopPlayback();

  source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(dryGain);
  source.connect(reverbNode);
  source.addEventListener('ended', () => {
    source = null;
    stopButton.disabled = true;
  });
  source.start();
  stopButton.disabled = false;
});

stopButton.addEventListener('click', stopPlayback);
