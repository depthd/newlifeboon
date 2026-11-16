// Isolated diagnostic of Antonio-R1's unchanged upstream JS processor.
// This emulates AudioWorklet globals in Node. It is not a browser/audio-quality test.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'upstream-worklet.js'), 'utf8');
const options = {
  cylinders: 4,
  intakeWaveguideLength: 100, exhaustWaveguideLength: 100, extractorWaveguideLength: 100,
  intakeOpenReflectionFactor: 0.01, intakeClosedReflectionFactor: 0.95,
  exhaustOpenReflectionFactor: 0.01, exhaustClosedReflectionFactor: 0.95,
  ignitionTime: 0.016, straightPipeWaveguideLength: 128, straightPipeReflectionFactor: 0.01,
  mufflerElementsLength: [10, 15, 20, 25], action: 0.1,
  outletWaveguideLength: 5, outletReflectionFactor: 0.01,
};
function render(sampleRate, rpm, throttle) {
  let seed = 12345;
  const seededMath = Object.create(Math);
  seededMath.random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let Processor;
  const sandbox = {
    sampleRate, Math: seededMath, Float32Array,
    AudioWorkletProcessor: class { constructor() { this.port = {}; } },
    registerProcessor: (_, ctor) => { Processor = ctor; },
  };
  vm.runInNewContext(source, sandbox);
  const processor = new Processor({ processorOptions: options });
  const frames = 128 * 400;
  const result = Array.from({ length: 3 }, () => new Float32Array(frames));
  for (let block = 0; block < 400; block++) {
    const outputs = Array.from({ length: 3 }, () => [new Float32Array(128)]);
    processor.process([], outputs, { rpm: new Float32Array([rpm]), throttle: new Float32Array([throttle]) });
    for (let channel = 0; channel < 3; channel++) result[channel].set(outputs[channel][0], block * 128);
  }
  if (result.some(channel => channel.some(value => !Number.isFinite(value)))) throw new Error('Non-finite output');
  return result;
}
function maxDifference(a, b) {
  let maximum = 0;
  for (let channel = 0; channel < a.length; channel++) {
    for (let frame = 0; frame < a[channel].length; frame++) {
      maximum = Math.max(maximum, Math.abs(a[channel][frame] - b[channel][frame]));
    }
  }
  return maximum;
}
const results = [44100, 48000].map(sampleRate => {
  const closed = render(sampleRate, 3000, 0);
  const open = render(sampleRate, 3000, 1);
  const changedRpm = render(sampleRate, 3300, 0);
  const throttleDifference = maxDifference(closed, open);
  const rpmDifference = maxDifference(closed, changedRpm);
  if (!(rpmDifference > 0)) throw new Error('Positive control failed: changed RPM was not detected');
  return { sampleRateHz: sampleRate, framesPerChannel: 51200, outputChannels: 3,
    rpm: 3000, throttlePair: [0, 1], maximumAbsoluteThrottleDifference: throttleDifference,
    positiveControlRpm: 3300, maximumAbsoluteRpmDifference: rpmDifference,
    conclusion: throttleDifference === 0 ? 'Throttle does not affect this processor output' : 'Throttle changes output' };
});
console.log(JSON.stringify({ upstreamCommit: 'c76c5adb9e63f5a54fb0def3b97e8e0ac1a7dea1',
  runtime: process.version, deterministicNoiseSeed: 12345,
  scope: 'Node VM only; not a browser performance or listening test', results }, null, 2));
