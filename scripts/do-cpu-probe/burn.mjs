// The probe's unit of work. The Durable Object runs it to burn CPU, and the workflow runs the same
// function in Node to calibrate iterations per millisecond. Workers freeze Date.now() and
// performance.now() during synchronous work, so the probe asks for an iteration count, not a time.
// The inner loop stays below 2^31 so its counter remains a small integer in both engines, and the
// checksum is returned so the JIT cannot drop the loop.

/** Iterations per inner block: below 2^31, and short enough to keep the loop counter an int32. */
export const BLOCK = 1_000_000;

/** A sanity cap on one request's work, far above anything the workflow's 120 s maximum asks for. */
export const MAX_ITERATIONS = 1e13;

/** Runs `iterations` rounds of an FNV-style integer hash and returns the 32-bit checksum. */
export function burn(iterations) {
  let h = 0x811c9dc5;
  let left = iterations;
  while (left > 0) {
    const n = left > BLOCK ? BLOCK : left;
    for (let i = 0; i < n; i++) {
      h = Math.imul(h ^ i, 0x01000193);
      h ^= h >>> 15;
    }
    left -= n;
  }
  return h >>> 0;
}
