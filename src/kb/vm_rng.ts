/**
 * Deterministic PRNG based on xorshift128+.
 *
 * Takes two 32-bit integer seeds (run_seed, world_seed) and produces
 * a sequence of deterministic pseudo-random numbers in [0, 1).
 *
 * Same seeds always produce the same sequence.
 * No wall-clock time, no Math.random(), no external state.
 */

export type Rng = {
  /** Returns next float in [0, 1) */
  next: () => number;
  /** Returns next integer in [0, max) */
  nextInt: (max: number) => number;
  /** Fork a new independent PRNG from current state + a salt */
  fork: (salt: number) => Rng;
};

export function createRng(seed1: number, seed2: number): Rng {
  let s0 = (seed1 | 0) || 1;  // ensure non-zero
  let s1 = (seed2 | 0) || 2;  // ensure non-zero

  function next(): number {
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= (x << 23) | 0;
    x ^= (x >>> 17) | 0;
    x ^= y | 0;
    x ^= (y >>> 26) | 0;
    s1 = x;
    return ((s0 + s1) >>> 0) / 4294967296;
  }

  function nextInt(max: number): number {
    return Math.floor(next() * max);
  }

  function fork(salt: number): Rng {
    next();
    return createRng(s0 ^ (salt | 0), s1 ^ ((salt * 2654435761) | 0));
  }

  return { next, nextInt, fork };
}
