/*
 * Four-stroke acoustic experiment, adapted from Antonio-R1/engine-sound-generator
 * commit c76c5adb9e63f5a54fb0def3b97e8e0ac1a7dea1.
 * Copyright (c) 2021-2022 Antonio-R1. MIT; see docs/audio-reference/LICENSE-Antonio-R1.
 * This is an acoustic candidate, not a calibrated K7M or a vehicle physics model.
 */
const TAU = 2 * Math.PI;
const REFERENCE_RATE = 44100;

/** Fractional travelling-wave delay. Time, not array length, is the parameter. */
class Delay {
  constructor(seconds, rate) {
    this.samples = seconds * rate;
    this.buffer = new Float64Array(Math.ceil(this.samples) + 2);
    this.index = 0;
  }
  read() {
    let p = this.index - this.samples;
    if (p < 0) p += this.buffer.length;
    const a = Math.floor(p), f = p - a;
    return this.buffer[a] * (1 - f) + this.buffer[(a + 1) % this.buffer.length] * f;
  }
  write(value) {
    this.buffer[this.index] = value;
    if (++this.index === this.buffer.length) this.index = 0;
  }
}

class Waveguide {
  constructor(referenceSamples, rate, left, right) {
    this.forward = new Delay(referenceSamples / REFERENCE_RATE, rate);
    this.backward = new Delay(referenceSamples / REFERENCE_RATE, rate);
    this.left = left; this.right = right;
    this.outLeft = 0; this.outRight = 0;
  }
  step(inputLeft, inputRight) {
    const l = this.backward.read(), r = this.forward.read();
    this.outLeft = l * (1 - this.left);
    this.outRight = r * (1 - this.right);
    this.forward.write(inputLeft + l * this.left);
    this.backward.write(inputRight + r * this.right);
  }
}

class Lowpass {
  constructor(hz, rate) { this.a = 1 - Math.exp(-TAU * hz / rate); this.y = 0; }
  step(x) { this.y += this.a * (x - this.y); return this.y; }
}

class Cylinder {
  constructor(rate, offset) {
    this.offset = offset;
    this.chamber = new Waveguide(10, rate, 0.75, 0.75);
    this.intake = new Waveguide(74, rate, -0.25, 0.95);
    this.exhaust = new Waveguide(91, rate, 0.95, 0.08);
    this.runner = new Waveguide(112, rate, 0.08, 0.10);
    this.mechanical = 0;
  }
  step(phase, intakeNoise, exhaustReturn, load, combustion) {
    let x = phase + this.offset;
    if (x >= 1) x -= 1;
    // A 720-degree cycle: power, exhaust, intake, compression. No ignition jitter.
    const exhaustValve = x > 0.25 && x < 0.5 ? -Math.sin(4 * Math.PI * x) : 0;
    const intakeValve = x > 0.5 && x < 0.75 ? Math.sin(4 * Math.PI * x) : 0;
    const piston = Math.cos(4 * Math.PI * x);
    // Crank-angle duration (degrees/720), not a fixed number of audio samples.
    const width = (30 - 15 * load) / 720;
    const ignition = x < width ? Math.sin(Math.PI * x / width) : 0;
    const firing = combustion * (0.12 + 1.65 * Math.pow(load, 0.75)) * ignition;
    this.intake.right = 0.95 - 0.93 * intakeValve;
    this.chamber.left = this.intake.right;
    this.exhaust.left = 0.95 - 0.93 * exhaustValve;
    this.chamber.right = this.exhaust.left;
    const chamberLeft = this.chamber.outLeft, chamberRight = this.chamber.outRight;
    const intakeRight = this.intake.outRight, runnerLeft = this.runner.outLeft;
    const exhaustRight = this.exhaust.outRight;
    this.runner.step(exhaustRight, exhaustReturn);
    this.exhaust.step(chamberRight, runnerLeft);
    this.chamber.step(0.10 * piston + 3.4 * firing + intakeRight * (1 - this.intake.right),
      runnerLeft * (1 - this.exhaust.left));
    this.intake.step(intakeNoise * intakeValve, chamberLeft * (1 - this.intake.right));
    // Piston/valve movement remains when combustion is disabled.
    this.mechanical = 0.09 * piston + 0.055 * (intakeValve + exhaustValve);
  }
}

export class EngineDSP {
  constructor(rate, seed = 0x1a2b3c4d) {
    this.rate = rate; this.phase = 0; this.eventCount = 0; this.firedCount = 0;
    this.seed = seed >>> 0;
    this.rpm = 750; this.load = 0.1; this.combustion = 1;
    this.targetRpm = 750; this.targetLoad = 0.1; this.targetCombustion = 1;
    this.aRpm = 1 - Math.exp(-1 / (0.020 * rate));
    this.aLoad = 1 - Math.exp(-1 / (0.015 * rate));
    this.aCombustion = 1 - Math.exp(-1 / (0.002 * rate));
    this.cylinders = Array.from({ length: 4 }, (_, i) => new Cylinder(rate, i / 4));
    this.pipe = new Waveguide(128, rate, 0.08, 0.10);
    this.mufflers = [71, 113, 173, 251].map(n => new Waveguide(n, rate, -0.14, 0.48));
    this.outlet = new Waveguide(39, rate, 0.10, -0.10);
    this.intakeNoise = new Lowpass(4200, rate);
    this.blockFilter = new Lowpass(700, rate);
    this.exhaustFilter = new Lowpass(5700, rate);
    this.outputFilter = new Lowpass(6500, rate);
    this.dc = new Lowpass(22, rate);
    this.noiseScale = Math.sqrt(rate / REFERENCE_RATE);
    this.lastIntake = 0; this.lastBlock = 0; this.lastExhaust = 0;
    this.potentialEvent = false; this.firingEvent = false;
  }
  setTarget(rpm, load01, combustionEnabled) {
    this.targetRpm = rpm; this.targetLoad = load01;
    this.targetCombustion = combustionEnabled ? 1 : 0;
  }
  next() {
    this.rpm += this.aRpm * (this.targetRpm - this.rpm);
    this.load += this.aLoad * (this.targetLoad - this.load);
    this.combustion += this.aCombustion * (this.targetCombustion - this.combustion);
    this.seed ^= this.seed << 13; this.seed ^= this.seed >>> 17; this.seed ^= this.seed << 5;
    const noise = this.intakeNoise.step(((this.seed >>> 0) / 2147483648 - 1) * this.noiseScale);
    const airflow = 0.025 + 0.32 * Math.pow(this.load, 1.3) * this.combustion;
    let intake = 0, block = 0, exhaust = 0;
    for (const cylinder of this.cylinders) {
      cylinder.step(this.phase, noise * airflow, this.pipe.outLeft, this.load, this.combustion);
      intake += cylinder.intake.outLeft;
      block += cylinder.mechanical + cylinder.chamber.outLeft * 0.045;
      exhaust += cylinder.runner.outRight;
    }
    let mufflerLeft = 0, mufflerRight = 0;
    for (const muffler of this.mufflers) {
      const l = muffler.outLeft, r = muffler.outRight;
      muffler.step(this.pipe.outRight * 0.25, this.outlet.outLeft * 0.25);
      mufflerLeft += l; mufflerRight += r;
    }
    this.pipe.step(exhaust * 0.25, mufflerLeft);
    this.outlet.step(mufflerRight, 0);
    // Load changes component balance as well as the combustion excitation above.
    this.lastIntake = intake * (0.12 + 0.65 * this.load);
    this.lastBlock = this.blockFilter.step(block) * 0.48;
    this.lastExhaust = this.exhaustFilter.step(this.outlet.outRight) * (0.65 + 0.30 * this.load);
    const mix = this.outputFilter.step(this.lastExhaust + this.lastIntake + this.lastBlock);
    const centered = mix - this.dc.step(mix);
    // Smooth bounded transfer with >5 dB sample headroom; true peak is checked separately.
    const output = 0.55 * Math.tanh(centered * 1.9);
    const before = Math.floor(this.phase * 4);
    this.phase += this.rpm / (120 * this.rate);
    const after = Math.floor(this.phase * 4);
    this.potentialEvent = before !== after;
    this.firingEvent = this.potentialEvent && this.targetCombustion > 0;
    if (this.potentialEvent) this.eventCount++;
    if (this.firingEvent) this.firedCount++;
    if (this.phase >= 1) this.phase -= 1;
    return output;
  }
}
