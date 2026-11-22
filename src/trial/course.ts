import type { Spot } from '../car/ground.ts';

export const straight = 120;
export const radius = 38;
export const halfWidth = 6;
const turn = Math.PI * radius;
export const trackLength = 2 * (straight + turn);

export function pointAt(distance: number) {
  const s = ((distance % trackLength) + trackLength) % trackLength;
  if (s < straight) return { x: s, z: 0, yaw: 0 };
  if (s < straight + turn) {
    const yaw = (s - straight) / radius;
    return { x: straight + radius * Math.sin(yaw), z: radius * (1 - Math.cos(yaw)), yaw };
  }
  if (s < 2 * straight + turn) return { x: 2 * straight + turn - s, z: 2 * radius, yaw: Math.PI };
  const yaw = Math.PI + (s - 2 * straight - turn) / radius;
  return { x: radius * Math.sin(yaw), z: radius * (1 - Math.cos(yaw)), yaw };
}

export function progressAt(x: number, z: number): number {
  if (x >= straight) return straight + radius * Math.atan2(x - straight, radius - z);
  if (x <= 0) return (trackLength + radius * Math.atan2(x, radius - z)) % trackLength;
  return z < radius ? x : 2 * straight + turn - x;
}

export function laneOffset(x: number, z: number): number {
  const nearestX = Math.min(straight, Math.max(0, x));
  return Math.hypot(x - nearestX, z - radius) - radius;
}

const asphalt: Spot = { height: 0, nx: 0, ny: 1, nz: 0, material: 'asphalt' };
const grass: Spot = { ...asphalt, material: 'grass' };
export function trackSurface(x: number, z: number): Spot {
  return Math.abs(laneOffset(x, z)) <= halfWidth ? asphalt : grass;
}
