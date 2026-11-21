import './lab.css';
import workletUrl from './engine-worklet.js?worker&url';
import { scenarios, fixture, timeline, eventCode, eventNames } from './fixtures.js';

const $ = id => document.getElementById(id);
let context, node, analyser, timer, captureResolve, scenarioName = null;
let sequence = 0, running = false, muted = false, pausedAt = null, epoch = 0;
let contextCount = 0, nodeCount = 0, framesSent = [], lastCapture = null;
let status = {}, processorErrors = [], captureInProgress = false;
let eventTimers = [], generation = 0;
const requestedRate = Number(new URLSearchParams(location.search).get('sr') ?? 48000);
$('sample-rate').value = String(requestedRate);
for (const [key, item] of Object.entries(scenarios)) $('scenario').add(new Option(item.title, key));

function output() { node?.port.postMessage({ type: 'output', running, volume: +$('volume').value, muted }); }
function send(rpm, load01, combustionEnabled, atAudioTimeS = context.currentTime, event = 'none') {
  const frame = { rpm, load01, combustionEnabled, sequence: ++sequence, atAudioTimeS, eventCode: eventCode(event) };
  node.port.postMessage({ type: 'frame', frame });
  if (captureInProgress) framesSent.push({ ...frame, sentAtAudioTimeS: context.currentTime, wallTimeMs: performance.now() });
}
function manual() {
  generation++; eventTimers.forEach(clearTimeout); eventTimers = [];
  clearInterval(timer); scenarioName = null; pausedAt = null;
  node?.port.postMessage({ type: 'flush' }); node?.port.postMessage({ type: 'mode', mode: 'manual' });
  if (context) send(+$('rpm').value, +$('load').value, $('combustion').checked);
  $('fresh').textContent = 'Ручной режим'; $('pause').textContent = 'Пауза';
}
async function enable() {
  if (!context) {
    context = new AudioContext({ sampleRate: +$('sample-rate').value, latencyHint: 'interactive' }); contextCount++;
    await context.audioWorklet.addModule(workletUrl);
    node = new AudioWorkletNode(context, 'engine-audio-lab', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] }); nodeCount++;
    node.onprocessorerror = () => { processorErrors.push('AudioWorklet processorerror'); $('message').textContent = 'Ошибка AudioWorklet'; };
    node.port.onmessage = ({ data }) => {
      if (data.type === 'status') {
        status = data; $('rpm-value').textContent = Math.round(data.rpm).toLocaleString('ru');
        $('fresh').textContent = scenarioName ? `Данные: ${Math.round(data.freshness * 100)}%` : 'Ручной режим';
      }
      if (data.type === 'capture-complete') {
        captureInProgress = false; lastCapture = unpack(data); captureResolve?.(lastCapture); captureResolve = null;
        $('message').textContent = 'Запись завершена. WAV и журнал доступны для сохранения.';
      }
    };
    analyser = context.createAnalyser(); analyser.fftSize = 1024;
    node.connect(analyser); analyser.connect(context.destination);
    $('sample-rate').disabled = true;
    $('rate').textContent = `${context.sampleRate.toLocaleString('ru')} Гц · факт`;
    for (const id of ['stop', 'mute', 'run', 'pause', 'manual', 'stall100', 'stall500', 'record', 'export']) $(id).disabled = false;
    manual();
  }
  await context.resume(); running = true; output();
  $('state').textContent = 'Двигатель звучит'; $('enable').textContent = 'Включить снова';
  return { sampleRate: context.sampleRate, contextCount, nodeCount };
}
function stop() { running = false; output(); $('state').textContent = 'Выход остановлен'; }
function run(name = $('scenario').value, hz = +$('hz').value) {
  generation++; eventTimers.forEach(clearTimeout); eventTimers = [];
  clearInterval(timer); node.port.postMessage({ type: 'flush' });
  scenarioName = name; pausedAt = null; epoch = context.currentTime + 0.025;
  node.port.postMessage({ type: 'mode', mode: 'active' });
  const tick = () => {
    if (pausedAt !== null) return;
    const at = context.currentTime + 0.020;
    const t = Math.max(0, at - epoch);
    if (t > scenarios[name].seconds) { clearInterval(timer); node.port.postMessage({ type: 'mode', mode: 'manual' }); return; }
    const f = fixture(name, t); send(f.rpm, f.load01, f.combustionEnabled, at, f.event);
  };
  tick(); timer = setInterval(tick, 1000 / hz); scheduleEvents();
  return epoch;
}
function scheduleEvents() {
  eventTimers.forEach(clearTimeout); eventTimers = [];
  if (!scenarioName) return;
  const token = generation, name = scenarioName;
  const commands = timeline(name, 120);
  for (let i = 1; i < commands.length; i++) {
    const f = commands[i], previous = commands[i - 1];
    if (f.event === previous.event && f.combustionEnabled === previous.combustionEnabled) continue;
    const at = epoch + f.time;
    if (at < context.currentTime) continue;
    eventTimers.push(setTimeout(() => {
      if (token !== generation || pausedAt !== null) return;
      send(f.rpm, f.load01, f.combustionEnabled, Math.max(at, context.currentTime), f.event);
    }, Math.max(0, (at - context.currentTime - 0.020) * 1000)));
  }
}
function pause() {
  if (!scenarioName) return;
  if (pausedAt === null) { pausedAt = context.currentTime; eventTimers.forEach(clearTimeout); node.port.postMessage({ type: 'mode', mode: 'paused' }); $('pause').textContent = 'Продолжить'; }
  else { epoch += context.currentTime - pausedAt; pausedAt = null; scheduleEvents(); node.port.postMessage({ type: 'mode', mode: 'active' }); $('pause').textContent = 'Пауза'; }
}
function stall(ms) { const before = performance.now(); while (performance.now() - before < ms) { /* intentional test */ } return performance.now() - before; }
function unpack(data) {
  const { pcm, trace, applied, firings, ...meta } = data;
  const values = new Float64Array(trace), rows = [];
  for (let r = 0; r < data.traceRows; r++) rows.push(Array.from(values.subarray(r * data.traceFields.length, (r + 1) * data.traceFields.length)));
  const a = new Float64Array(applied), appliedRows = [];
  for (let r = 0; r < data.appliedRows; r++) appliedRows.push(Array.from(a.subarray(r * 8, r * 8 + 8)));
  return { pcm: new Float32Array(pcm), journal: { ...meta, eventNames, rows, appliedRows,
    firingSampleIndices: Array.from(new Float64Array(firings).subarray(0, data.firingRows)),
    source: 'test fixture, not vehicle telemetry', projectCommit: 'c9faa71a16fde48c2beb0db362189b82bb958149',
    upstreamCommit: 'c76c5adb9e63f5a54fb0def3b97e8e0ac1a7dea1' } };
}
async function record(seconds = 8) {
  if (captureInProgress) throw new Error('A recording is already in progress');
  framesSent = []; captureInProgress = true;
  const result = new Promise(resolve => { captureResolve = resolve; });
  node.port.postMessage({ type: 'capture', seconds });
  const capture = await result;
  capture.journal.framesSent = framesSent; capture.journal.scenarioEpochAudioTimeS = epoch;
  return capture;
}
async function offline(name, sampleRate = requestedRate, hz = 60) {
  const specification = scenarios[name];
  const offlineContext = new OfflineAudioContext(1, Math.ceil(specification.seconds * sampleRate), sampleRate);
  await offlineContext.audioWorklet.addModule(workletUrl);
  const commands = timeline(name, hz).map(f => ({ ...f, eventCode: eventCode(f.event) }));
  const processor = new AudioWorkletNode(offlineContext, 'engine-audio-lab', { numberOfInputs: 0,
    outputChannelCount: [1], processorOptions: { offline: true, timeline: commands, captureFrames: offlineContext.length } });
  const capture = new Promise((resolve, reject) => {
    processor.onprocessorerror = () => reject(new Error('Offline processorerror'));
    processor.port.onmessage = ({ data }) => { if (data.type === 'capture-complete') resolve(unpack(data)); };
  });
  processor.connect(offlineContext.destination);
  const started = performance.now();
  await offlineContext.startRendering();
  const wallRenderMs = performance.now() - started;
  const result = await capture;
  processor.disconnect(); processor.port.close();
  Object.assign(result.journal, { scenario: name, hz, requestedSampleRate: sampleRate,
    actualSampleRate: offlineContext.sampleRate, wallRenderMs, renderSeconds: specification.seconds,
    performanceMethod: 'Browser OfflineAudioContext wall time, includes capture; not isolated live DSP timing', commands });
  return result;
}
function wav(pcm, rate) {
  const bytes = new ArrayBuffer(44 + pcm.length * 3), view = new DataView(bytes);
  const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 3, true); view.setUint16(32, 3, true); view.setUint16(34, 24, true);
  text(36, 'data'); view.setUint32(40, pcm.length * 3, true);
  for (let i = 0; i < pcm.length; i++) {
    const n = Math.round(Math.max(-1, Math.min(1, pcm[i])) * 8388607);
    view.setUint8(44 + i * 3, n & 255); view.setUint8(45 + i * 3, (n >> 8) & 255); view.setUint8(46 + i * 3, (n >> 16) & 255);
  }
  return new Uint8Array(bytes);
}
function pack(result) {
  const bytes = wav(result.pcm, result.journal.sampleRate);
  let binary = ''; for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return { wavBase64: btoa(binary), journal: result.journal };
}
function download(result, name) {
  for (const [suffix, blob] of [['wav', new Blob([wav(result.pcm, result.journal.sampleRate)], { type: 'audio/wav' })],
    ['json', new Blob([JSON.stringify(result.journal)], { type: 'application/json' })]]) {
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${name}.${suffix}`; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
}
function bind(id, fn) { $(id).addEventListener('click', () => Promise.resolve().then(fn).catch(e => { $('message').textContent = String(e); processorErrors.push(String(e)); })); }
bind('enable', enable); bind('stop', stop); bind('run', () => run()); bind('manual', manual); bind('pause', pause);
bind('mute', () => { muted = !muted; $('mute').setAttribute('aria-pressed', String(muted)); output(); });
bind('stall100', () => stall(100)); bind('stall500', () => stall(500));
bind('record', async () => { $('message').textContent = 'Запись 8 секунд…'; download(await record(), 'live'); });
bind('export', async () => { $('message').textContent = 'Рендеринг сценария…'; download(await offline($('scenario').value, context.sampleRate, +$('hz').value), $('scenario').value); $('message').textContent = 'WAV и журнал сохранены'; });
for (const id of ['rpm', 'load', 'combustion']) $(id).addEventListener('input', () => {
  $('rpm-label').textContent = `${$('rpm').value} об/мин`; $('load-label').textContent = (+$('load').value).toFixed(2).replace('.', ',');
  if (node) manual();
});
$('volume').addEventListener('input', () => { $('volume-label').textContent = `${Math.round(+$('volume').value * 100)}%`; output(); });
const canvas = $('wave'), painter = canvas.getContext('2d'), scope = new Float32Array(1024);
function draw() {
  canvas.width = Math.max(100, Math.floor(canvas.clientWidth * devicePixelRatio)); canvas.height = Math.floor(92 * devicePixelRatio);
  painter.clearRect(0, 0, canvas.width, canvas.height); painter.strokeStyle = '#dfa76e'; painter.lineWidth = devicePixelRatio;
  if (analyser) analyser.getFloatTimeDomainData(scope);
  painter.beginPath(); for (let i = 0; i < scope.length; i++) {
    const x = i / (scope.length - 1) * canvas.width, y = canvas.height * (0.5 - scope[i] * 0.65);
    if (i === 0) painter.moveTo(x, y); else painter.lineTo(x, y);
  } painter.stroke(); requestAnimationFrame(draw);
} draw();
window.audioLab = { enable, stop, manual, run, pause, stall, record, offline, pack,
  debug: () => ({ contextCount, nodeCount, state: context?.state, sampleRate: context?.sampleRate,
    baseLatency: context?.baseLatency, outputLatency: context?.outputLatency, status, processorErrors }),
  getEpoch: () => epoch };
