#!/usr/bin/env node
// tools/encrypt-letter.js  --  encrypts / decrypts data/letters.json for the
// DanyAndJenny love-letter site. Uses the WebCrypto SubtleCrypto API (works
// identically in Node via crypto.webcrypto AND in the browser), so the
// encryption here is byte-for-byte what index.html will decrypt in-browser.
//
// Security model:
//   - data/letters.json on disk / on GitHub is CIPHERTEXT only.
//   - The passphrase is NEVER stored anywhere -- it's typed once
//     by the visitor each browser session to derive the AES key in memory.
//   - PBKDF2-SHA256, 600 000 iterations, fixed salt (constants must match
//     the ones hardcoded in index.html).
//
// Usage:
//   node tools/encrypt-letter.js encrypt [passphrase]   # stdin  -> stdout (ciphertext)
//   node tools/encrypt-letter.js decrypt [passphrase]   # stdin  -> stdout (plaintext)

const crypto = require('crypto');
const { webcrypto } = crypto;
const { subtle } = webcrypto;

const SALT      = new TextEncoder().encode('our-love-letters-v1');   // must match index.html
const ITER      = 600_000;
const PASSPHRASE = process.argv[3] || process.env.LETTER_PASSPHRASE;
if (!PASSPHRASE) {
  console.error('Passphrase required — set LETTER_PASSPHRASE env var or pass as the 3rd arg.\nUsage: node tools/encrypt-letter.js <encrypt|decrypt> [passphrase]  < input.json');
  process.exit(1);
}

function buf2b64(u8)  { return Buffer.from(u8).toString('base64'); }
function b64toBuf(b64){ return new Uint8Array(Buffer.from(b64, 'base64')); }

async function deriveKey(pass) {
  const keyMat = await subtle.importKey(
    'raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits', 'deriveKey']
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: ITER, hash: 'SHA-256' },
    keyMat, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function encrypt(text) {
  const key = await deriveKey(PASSPHRASE);
  const iv  = crypto.randomBytes(12);                // 96-bit IV, random per encryption
  const ct  = await subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)
  );
  return JSON.stringify({ iv: buf2b64(iv), ct: buf2b64(new Uint8Array(ct)) });
}

async function decrypt(blob) {
  const { iv, ct } = JSON.parse(blob);
  const key = await deriveKey(PASSPHRASE);
  const pt  = await subtle.decrypt(
    { name: 'AES-GCM', iv: b64toBuf(iv) }, key, b64toBuf(ct)
  );
  return new TextDecoder().decode(pt);
}

// --- CLI ---
(async () => {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  const mode = (process.argv[2] || '').toLowerCase();
  try {
    if (mode === 'encrypt') process.stdout.write(await encrypt(data));
    else if (mode === 'decrypt') process.stdout.write(await decrypt(data));
    else {
      console.error('Usage: node tools/encrypt-letter.js <encrypt|decrypt> [passphrase]  < input.json');
      process.exit(1);
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
