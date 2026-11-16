// All values below are fixture commands, never measured vehicle loads or gearbox physics.
export const scenarios = {
  idle: { title: 'Холостой ход · 30 с', seconds: 30 },
  sweep: { title: '750 → 5800 → 750 об/мин', seconds: 18 },
  loads: { title: '2000 / 3500 · нагрузка 0,1 / 0,5 / 1', seconds: 18 },
  combustion: { title: 'Отключение сгорания при 3000 об/мин', seconds: 8 },
  shifts: { title: 'Заданные переключения', seconds: 10 },
  limiter: { title: 'Заданная отсечка', seconds: 8 },
  response: { title: 'Ступень на 2-й секунде', seconds: 6 },
};
export function fixture(name, t) {
  let rpm = 750, load01 = 0.1, combustionEnabled = true, event = 'none';
  if (name === 'sweep') {
    const u = Math.max(0, Math.min(1, (t < 9 ? t - 1 : 17 - t) / 8));
    rpm = 750 + 5050 * u; load01 = t < 9 ? 0.8 : 0.15;
  } else if (name === 'loads') {
    const segment = Math.min(5, Math.floor(Math.max(0, t) / 3));
    rpm = segment < 3 ? 2000 : 3500; load01 = [0.1, 0.5, 1][segment % 3];
    event = `load-${segment}`;
  } else if (name === 'combustion') {
    rpm = 3000; load01 = 0.65; combustionEnabled = t < 2 || t >= 5;
    event = combustionEnabled ? 'combustion-on' : 'combustion-off';
  } else if (name === 'shifts') {
    rpm = 1800 + 1100 * Math.min(t, 3); load01 = 0.85;
    if (t >= 3) { rpm = 3100 + 600 * Math.min(t - 3, 3); event = 'upshift'; }
    if (t >= 6) { rpm = 4200 - 250 * (t - 6); load01 = 0.2; event = 'downshift'; }
    combustionEnabled = !(t >= 3 && t < 3.25) && !(t >= 6 && t < 6.2);
  } else if (name === 'limiter') {
    rpm = Math.min(5800, 4000 + t * 900); load01 = 1;
    if (t >= 2 && t < 6) {
      combustionEnabled = ((t - 2) % 0.12) >= 0.045;
      event = combustionEnabled ? 'limiter-on' : 'limiter-cut';
    }
  } else if (name === 'response') {
    rpm = t < 2 ? 2000 : 3500; load01 = t < 2 ? 0.1 : 1;
    event = t < 2 ? 'before-step' : 'after-step';
  }
  return { rpm, load01, combustionEnabled, event };
}
export const eventNames = ['none', 'combustion-on', 'combustion-off', 'upshift', 'downshift',
  'limiter-on', 'limiter-cut', 'before-step', 'after-step', ...Array.from({ length: 6 }, (_, i) => `load-${i}`)];
export const eventCode = name => Math.max(0, eventNames.indexOf(name));

export function timeline(name, hz = 60) {
  const seconds = scenarios[name].seconds;
  const times = new Set([0]);
  for (let i = 1; i < seconds * hz; i++) times.add(i / hz);
  // Explicit fixture events are not quantised to the parameter update frequency.
  if (name === 'combustion') [2, 5].forEach(t => times.add(t));
  if (name === 'shifts') [3, 3.25, 6, 6.2].forEach(t => times.add(t));
  if (name === 'response') times.add(2);
  if (name === 'limiter') {
    for (let cycle = 0; cycle < 34; cycle++) {
      const a = 2 + cycle * 0.12;
      if (a < 6) { times.add(a); times.add(a + 0.045); }
    }
    times.add(6);
  }
  return [...times].sort((a, b) => a - b).filter(t => t < seconds).map((time, sequence) => ({
    time, sequence: sequence + 1, ...fixture(name, time + 1e-9),
  }));
}
