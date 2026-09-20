/**
 * Float64 Fourier transforms. Replaces the vendored FFTW 2.x (rfftw) the original used.
 *
 * Both routines compute the forward DFT X[k] = sum_n x[n] * exp(-2*pi*i*k*n/N), the same sign
 * convention as FFTW_FORWARD, with no normalisation.
 */

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/** Smallest power of two >= n. */
export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Largest power of two <= n. This is what the original's misnamed NearestPowerOfTwo returns. */
export function floorPowerOfTwo(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/** In-place iterative radix-2 FFT. `re` and `im` must have the same power-of-two length. */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (im.length !== n) throw new Error('fft: re and im must be the same length');
  if (!isPowerOfTwo(n)) throw new Error(`fft: length ${n} is not a power of two`);
  if (n === 1) return;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const theta = (-2 * Math.PI) / len;
    const wr = Math.cos(theta);
    const wi = Math.sin(theta);
    for (let start = 0; start < n; start += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const br = re[b] as number;
        const bi = im[b] as number;
        const tr = br * cr - bi * ci;
        const ti = br * ci + bi * cr;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Straightforward O(N^2) DFT of a real signal, for any length N. Only used to reproduce the
 * original's arbitrary-length branch (selections of <= 5000 samples), where FFTW handled
 * non-power-of-two sizes natively. 5000 samples is ~25M multiply-adds, which is fast enough.
 *
 * Returns the full complex spectrum, length N.
 */
export function dftReal(input: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = input.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  // Precompute twiddles once; index (k*j) mod n keeps them exact rather than accumulating.
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (-2 * Math.PI * i) / n;
    cos[i] = Math.cos(a);
    sin[i] = Math.sin(a);
  }
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let j = 0; j < n; j++) {
      const idx = (k * j) % n;
      const x = input[j] as number;
      sr += x * (cos[idx] as number);
      si += x * (sin[idx] as number);
    }
    re[k] = sr;
    im[k] = si;
  }
  return { re, im };
}
