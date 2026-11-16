// Real Chromium AudioWorklet checks. Offline wall time is not claimed as live DSP time.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const out = path.resolve(process.argv[2] ?? '../engine-audio-results');
for (const sub of ['wav', 'journals']) await fs.mkdir(path.join(out, sub), { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const report = { browser: browser.version(), node: process.version, os: os.release(), cpu: os.cpus()[0]?.model,
  logicalCpus: os.cpus().length, date: new Date().toISOString(), mode: 'headless real Chromium, browser audio graph; no physical output verified',
  offline: [], live: [], errors: [] };
async function save(name, packed) {
  await fs.writeFile(path.join(out, 'wav', name + '.wav'), Buffer.from(packed.wavBase64, 'base64'));
  await fs.writeFile(path.join(out, 'journals', name + '.json'), JSON.stringify(packed.journal));
}
try {
  for (const sr of [44100, 48000]) {
    const page = await browser.newPage({ viewport: { width: 1240, height: 1040 } });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(`http://localhost:5200/audio-lab.html?sr=${sr}`);
    const before = await page.evaluate(() => window.audioLab.debug());
    if (before.contextCount !== 0) throw new Error('AudioContext created before user gesture');
    await page.click('#enable'); await page.waitForFunction(() => window.audioLab.debug().state === 'running');
    for (const scenario of ['idle', 'sweep', 'loads', 'combustion', 'shifts', 'limiter']) {
      const started = Date.now();
      const data = await page.evaluate(async ({ scenario, sr }) => window.audioLab.pack(await window.audioLab.offline(scenario, sr)), { scenario, sr });
      await save(`${scenario}-${sr}`, data);
      report.offline.push({ scenario, requestedRate: sr, actualRate: data.journal.actualSampleRate,
        wallRenderMs: data.journal.wallRenderMs, seconds: data.journal.renderSeconds,
        quantumGaps: data.journal.quantumGaps, invalid: data.journal.invalidMessages,
        frames: data.journal.frames });
      console.log(`${scenario} ${sr}: ${data.journal.wallRenderMs.toFixed(0)} ms / ${data.journal.renderSeconds} s (${Date.now() - started} ms with transfer)`);
    }
    for (const hz of [15, 30, 60, 120]) {
      const data = await page.evaluate(async ({ sr, hz }) => window.audioLab.pack(await window.audioLab.offline('sweep', sr, hz)), { sr, hz });
      await save(`updates-${hz}-${sr}`, data);
      report.offline.push({ scenario: 'updates', hz, requestedRate: sr, actualRate: data.journal.actualSampleRate,
        wallRenderMs: data.journal.wallRenderMs, seconds: data.journal.renderSeconds, quantumGaps: data.journal.quantumGaps, frames: data.journal.frames });
    }
    // Four real-time delivery rates; deliberate main-thread stalls straddle the t=2 event.
    for (const [hz, stallMs] of [[15, 0], [30, 100], [60, 500], [120, 0]]) {
      const live = await page.evaluate(async ({ hz, stallMs }) => {
        window.audioLab.manual();
        const epoch = window.audioLab.run('response', hz);
        const capture = window.audioLab.record(6);
        const block = { requestedMs: stallMs };
        if (stallMs) setTimeout(() => { block.before = performance.now(); block.actualMs = window.audioLab.stall(stallMs); block.after = performance.now(); }, 1950);
        const result = await capture;
        Object.assign(result.journal, { hz, block, scenario: 'response', epoch, debug: window.audioLab.debug() });
        return window.audioLab.pack(result);
      }, { hz, stallMs });
      await save(`live-${hz}-stall${stallMs}-${sr}`, live);
      report.live.push({ sr, hz, stallMs, block: live.journal.block, quantumGaps: live.journal.quantumGaps,
        frames: live.journal.frames, debug: live.journal.debug });
      console.log(`live ${sr} ${hz} Hz stall ${stallMs}: ${live.journal.quantumGaps} quantum gaps`);
    }
    const lifecycle = await page.evaluate(async () => {
      window.audioLab.manual();
      for (let i = 0; i < 15; i++) { window.audioLab.stop(); await window.audioLab.enable(); }
      return window.audioLab.debug();
    });
    if (lifecycle.contextCount !== 1 || lifecycle.nodeCount !== 1) throw new Error('Lifecycle duplicated audio graph');
    report.live.push({ sr, lifecycle });
    await page.screenshot({ path: path.join(out, `stand-${sr}.png`), fullPage: true });
    await page.close();
    await fs.writeFile(path.join(out, 'browser-results.json'), JSON.stringify(report, null, 2));
  }
  if (report.errors.length || report.live.some(x => x.debug?.processorErrors.length)) throw new Error('Browser errors');
} finally {
  await fs.writeFile(path.join(out, 'browser-results.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
