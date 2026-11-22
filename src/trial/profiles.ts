import type { Passport } from '../car/passport.ts';

export type Balance = 'standard' | 'a' | 'b';

/** Слепые опыты: одинаковое уменьшение поперечного сцепления на одной оси. */
export function trialPassport(base: Passport, balance: Balance): Passport {
  if (balance === 'standard') return base;
  const factors: readonly [number, number] = balance === 'a' ? [0.6, 1] : [1, 0.6];
  return { ...base, шина: { ...base.шина, lateralGripByAxle: factors } };
}
