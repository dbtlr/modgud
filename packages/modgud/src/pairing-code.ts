import { randomBytes } from 'node:crypto';

// Crockford's base32 alphabet: digits and letters without I, L, O, and U.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// The letters Crockford's base32 reads as the digits they resemble.
const LOOKALIKES: Record<string, string> = { I: '1', L: '1', O: '0' };

const CODE_LENGTH = 8;
const CANONICAL_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/u;

// Mints a Pairing code: 40 random bits as eight Crockford base32 characters,
// shown as XXXX-XXXX.
export const mintPairingCode = () => {
  let bits = 0n;
  for (const byte of randomBytes(5)) {
    bits = (bits << 8n) | BigInt(byte);
  }
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code = `${ALPHABET[Number(bits & 31n)] ?? ''}${code}`;
    bits >>= 5n;
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
};

// The canonical form of a Pairing code as a person entered it: case, spaces,
// and hyphens do not matter, and I, L, and O read as 1, 1, and 0. Undefined
// when the entry is not eight characters of the alphabet.
export const normalizePairingCode = (entry: string): string | undefined => {
  const code = entry
    .replaceAll(/[ -]/gu, '')
    .toUpperCase()
    .replaceAll(/[ILO]/gu, (letter) => LOOKALIKES[letter] ?? letter);
  return CANONICAL_CODE.test(code) ? code : undefined;
};
