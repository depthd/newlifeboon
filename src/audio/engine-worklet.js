/* MIT-derived DSP; attribution and exact upstream revision in docs/audio-reference/. */
import { EngineDSP } from './engine-dsp.js';

export const TRACE_FIELDS = ['sampleIndex', 'audioTimeS', 'sequence', 'targetRpm', 'targetLoad01',
  'combustionEnabled', 'smoothedRpm', 'smoothedLoad01', 'combustionEnvelope', 'cyclePhase01',
  'potentialFiringCount', 'actualFiringCount', 'freshnessGain', 'outputGain', 'dataAgeS', 'eventCode'];
const FIELDS = TRACE_FIELDS.length;
const MODE = { manual: 0, active: 1, paused: 2 };

class EngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions ?? {};
    this.dsp = new EngineDSP(sampleRate);
    this.mode = config.offline ? MODE.active : MODE.manual;
    this.running = !!config.offline; this.volume = config.offline ? 1 : 0.65; this.muted = false;
    this.outputGain = 0; this.freshness = 1;
    this.outputAlpha = 1 - Math.exp(-1 / (0.010 * sampleRate));
    this.sequence = 0; this.lastAcceptedSequence = 0; this.lastAcceptedTime = -Infinity;
    this.lastDataTime = 0; this.event = 0; this.invalid = 0; this.rejected = 0;
    this.lastQuantum = -1; this.lastQuantumLength = 0; this.quantumGaps = 0; this.blocks = 0;
    this.queue = new Float64Array(512 * 7); this.readIndex = 0; this.writeIndex = 0;
    this.fixture = config.timeline ?? []; this.fixtureIndex = 0;
    this.capture = null;
    if (config.captureFrames) this.startCapture(config.captureFrames);
    this.port.onmessage = ({ data }) => this.message(data);
    this.port.postMessage({ type: 'ready', sampleRate, dspTimerAvailable: typeof performance !== 'undefined' });
  }
  startCapture(frames) {
    const count = Math.min(Math.ceil(frames), sampleRate * 40);
    this.capture = {
      pcm: new Float32Array(count), trace: new Float64Array((Math.ceil(count / sampleRate * 100) + 4) * FIELDS),
      applied: new Float64Array((Math.ceil(count / sampleRate * 160) + 512) * 8),
      firings: new Float64Array(Math.ceil(count / sampleRate * 280) + 16),
      position: 0, tracePosition: 0, appliedPosition: 0, firingPosition: 0,
      nextTrace: 0, startFrame: -1, invalidAtStart: this.invalid, rejectedAtStart: this.rejected,
      gapsAtStart: this.quantumGaps,
    };
  }
  message(data) {
    if (data.type === 'frame') {
      const f = data.frame;
      if (!f || !Number.isSafeInteger(f.sequence) || !Number.isFinite(f.atAudioTimeS)
        || !Number.isFinite(f.rpm) || f.rpm < 0 || f.rpm > 8000
        || !Number.isFinite(f.load01) || f.load01 < 0 || f.load01 > 1
        || typeof f.combustionEnabled !== 'boolean') { this.invalid++; return; }
      if (f.sequence <= this.lastAcceptedSequence
        || f.atAudioTimeS < currentTime - 0.250 || this.writeIndex - this.readIndex >= 512) {
        this.rejected++; return;
      }
      // Fixture events and parameter updates may arrive in a different order than their audio times.
      let insertion = this.writeIndex;
      while (insertion > this.readIndex && this.queue[((insertion - 1) % 512) * 7] > f.atAudioTimeS) {
        const from = ((insertion - 1) % 512) * 7, to = (insertion % 512) * 7;
        for (let field = 0; field < 7; field++) this.queue[to + field] = this.queue[from + field];
        insertion--;
      }
      this.writeIndex++;
      const index = (insertion % 512) * 7;
      this.queue.set([f.atAudioTimeS, f.sequence, f.rpm, f.load01, +f.combustionEnabled, f.eventCode ?? 0, 0], index);
      this.lastAcceptedSequence = f.sequence; this.lastAcceptedTime = f.atAudioTimeS;
    } else if (data.type === 'mode') {
      if (Object.hasOwn(MODE, data.mode)) { this.mode = MODE[data.mode]; this.lastDataTime = currentTime; }
    } else if (data.type === 'output') {
      this.running = !!data.running; this.muted = !!data.muted;
      if (Number.isFinite(data.volume)) this.volume = Math.max(0, Math.min(1, data.volume));
    } else if (data.type === 'capture') {
      if (Number.isFinite(data.seconds) && data.seconds > 0 && data.seconds <= 40 && !this.capture) {
        this.startCapture(Math.ceil(data.seconds * sampleRate));
        this.port.postMessage({ type: 'capture-started', frames: this.capture.pcm.length });
      }
    } else if (data.type === 'flush') {
      this.readIndex = this.writeIndex; this.fixtureIndex = this.fixture.length;
      this.lastAcceptedTime = -Infinity;
    }
  }
  apply(time, sequence, rpm, load, combustion, event, sample) {
    this.sequence = sequence; this.lastDataTime = time; this.event = event;
    this.dsp.setTarget(rpm, load, combustion);
    const capture = this.capture;
    if (capture && capture.appliedPosition + 8 <= capture.applied.length) {
      capture.applied.set([sample, time, currentTime + (sample + capture.startFrame - currentFrame) / sampleRate,
        sequence, rpm, load, +combustion, event], capture.appliedPosition);
      capture.appliedPosition += 8;
    }
  }
  finishCapture() {
    const c = this.capture;
    this.port.postMessage({ type: 'capture-complete', sampleRate, startFrame: c.startFrame,
      frames: c.pcm.length, traceRows: c.tracePosition / FIELDS, appliedRows: c.appliedPosition / 8,
      firingRows: c.firingPosition, traceFields: TRACE_FIELDS,
      appliedFields: ['sampleIndex', 'requestedAudioTimeS', 'appliedAudioTimeS', 'sequence', 'rpm', 'load01', 'combustionEnabled', 'eventCode'],
      quantumGaps: this.quantumGaps - c.gapsAtStart, invalidMessages: this.invalid - c.invalidAtStart,
      rejectedMessages: this.rejected - c.rejectedAtStart,
      pcm: c.pcm.buffer, trace: c.trace.buffer, applied: c.applied.buffer, firings: c.firings.buffer,
    }, [c.pcm.buffer, c.trace.buffer, c.applied.buffer, c.firings.buffer]);
    this.capture = null;
  }
  process(_inputs, outputs) {
    const output = outputs[0][0];
    if (this.lastQuantum >= 0 && currentFrame !== this.lastQuantum + this.lastQuantumLength) this.quantumGaps++;
    this.lastQuantum = currentFrame; this.lastQuantumLength = output.length; this.blocks++;
    if (this.capture && this.capture.startFrame < 0) this.capture.startFrame = currentFrame;
    for (let i = 0; i < output.length; i++) {
      const time = (currentFrame + i) / sampleRate;
      const capture = this.capture;
      const sample = capture ? currentFrame + i - capture.startFrame : 0;
      while (this.fixtureIndex < this.fixture.length && this.fixture[this.fixtureIndex].time <= time) {
        const f = this.fixture[this.fixtureIndex++];
        this.apply(f.time, f.sequence, f.rpm, f.load01, f.combustionEnabled, f.eventCode, sample);
      }
      while (this.readIndex < this.writeIndex && this.queue[(this.readIndex % 512) * 7] <= time) {
        const index = (this.readIndex++ % 512) * 7;
        this.apply(this.queue[index], this.queue[index + 1], this.queue[index + 2], this.queue[index + 3],
          !!this.queue[index + 4], this.queue[index + 5], sample);
      }
      const age = Math.max(0, time - this.lastDataTime);
      const freshTarget = this.mode === MODE.active && age > 0.250 ? 0 : 1;
      // Linear 100 ms ramps, with no dependence on frame or message frequency.
      const delta = 1 / (0.100 * sampleRate);
      this.freshness += Math.max(-delta, Math.min(delta, freshTarget - this.freshness));
      const wantedGain = this.running && !this.muted && this.mode !== MODE.paused ? this.volume : 0;
      this.outputGain += this.outputAlpha * (wantedGain - this.outputGain);
      // Stop keeps the graph, but stops core computation once the output has faded.
      const value = this.running || this.outputGain > 1e-7 ? this.dsp.next() : 0;
      output[i] = value * this.outputGain * this.freshness;
      if (capture && capture.position < capture.pcm.length) {
        capture.pcm[capture.position++] = output[i];
        if (this.dsp.firingEvent && capture.firingPosition < capture.firings.length && (this.running || this.outputGain > 1e-7)) {
          capture.firings[capture.firingPosition++] = sample + 1;
        }
        if (sample >= capture.nextTrace) {
          capture.trace.set([sample, time, this.sequence, this.dsp.targetRpm, this.dsp.targetLoad,
            this.dsp.targetCombustion, this.dsp.rpm, this.dsp.load, this.dsp.combustion, this.dsp.phase,
            this.dsp.eventCount, this.dsp.firedCount, this.freshness, this.outputGain, age, this.event], capture.tracePosition);
          capture.tracePosition += FIELDS;
          capture.nextTrace += sampleRate / 100;
        }
        if (capture.position === capture.pcm.length) this.finishCapture();
      }
    }
    if (this.blocks % Math.ceil(sampleRate / output.length / 5) === 0) {
      this.port.postMessage({ type: 'status', rpm: this.dsp.rpm, load01: this.dsp.load,
        combustion: this.dsp.combustion, freshness: this.freshness, gain: this.outputGain,
        phase: this.dsp.phase, sequence: this.sequence, quantumGaps: this.quantumGaps,
        invalidMessages: this.invalid, rejectedMessages: this.rejected, blockSize: output.length });
    }
    return true;
  }
}
registerProcessor('engine-audio-lab', EngineProcessor);
