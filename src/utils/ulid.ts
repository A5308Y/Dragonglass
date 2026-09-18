const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = -1;
let lastRandom: Uint8Array = new Uint8Array(10);

export function createUlid(now = Date.now()): string {
  const random = now === lastTime ? increment(lastRandom) : freshRandom();
  lastTime = now;
  lastRandom = random;
  return encodeTime(now) + encodeRandom(random);
}

function freshRandom(): Uint8Array {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function increment(previous: Uint8Array): Uint8Array {
  const bytes = previous.slice();
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    if (bytes[index] !== 255) {
      bytes[index] = (bytes[index] ?? 0) + 1;
      return bytes;
    }
    bytes[index] = 0;
  }
  throw new Error("ULID random component overflowed within one millisecond.");
}

function encodeTime(value: number): string {
  let remaining = value;
  let output = "";
  for (let index = 0; index < 10; index += 1) {
    output = ENCODING[remaining % 32] + output;
    remaining = Math.floor(remaining / 32);
  }
  return output;
}

function encodeRandom(bytes: Uint8Array): string {
  let buffer = 0;
  let bits = 0;
  let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ENCODING[(buffer >>> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  return output.padEnd(16, "0");
}
