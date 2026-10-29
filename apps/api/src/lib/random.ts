import { randomInt } from "node:crypto";

/** Generates a string of `n` random decimal digits (e.g. "042817"). */
// FIX: was Math.floor(Math.random() * 10 ** n). Math.random is a
// non-cryptographic PRNG (V8 xorshift128+): its state can be recovered from a
// handful of outputs, after which future OTP codes are predictable. OTP codes
// are the second login factor, so they need crypto randomness.
export function randomDigits(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += String(randomInt(10));
  return out;
}

/** Generates a string of `n` characters drawn uniformly from `alphabet`. */
export function randomFromAlphabet(alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[randomInt(alphabet.length)]; // FIX: crypto, not Math.random
  }
  return out;
}

/** Short display-only reference for receipts and logs (e.g. "FP-A7K2M3"). */
export function displayReference(): string {
  return `FP-${randomFromAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6)}`;
}
