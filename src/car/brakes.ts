/**
 * Управление давлением ABS. Давление выражено долей полного тормозного момента.
 * Скорости клапанов — оценки модели. 0.125 с до полного давления, сброс втрое быстрее.
 */
export function brakePressure(previous: number, pedal: number, slip: number, peakSlip: number, dt: number): number {
  if (slip > peakSlip) return Math.max(0, Math.min(previous, pedal) - 24 * dt);
  if (slip < peakSlip * 0.8) return Math.min(pedal, previous + 8 * dt);
  return Math.min(pedal, previous);
}
