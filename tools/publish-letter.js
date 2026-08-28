#!/usr/bin/env node
// tools/publish-letter.js  --  one-command OCR -> Review -> Publish flow.
//
// Letters are stored ENCRYPTED in data/letters.json. Publishing a reviewed
// letter therefore decrypts the file, adds the entry, and re-encrypts —
// the passphrase is prompted for (or read from LETTER_PASSPHRASE env).
//
// Usage:
//   node tools/publish-letter.js <letterId> [jennerino|dannerino] [emoji]
//
// Run #1 (no *.typed.txt file yet): OCRs the uploaded photos, writes a
//   review file at data/letters/<letterId>.typed.txt, asks you to re-run.
// Run #2 (review file exists): decrypts letters.json, adds the typed letter,
//   re-encrypts, writes data/letters.json, and prints commit/push steps.
//
// Examples:
//   node tools/publish-letter.js letter-20260823-115201 jennerino 🧁
//   node tools/publish-letter.js letter-20260823-115201 dannerino 💌

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execSync, spawnSync } = require('child_process');

const WORKER_URL = 'https://ourloveletters.weidan-hng.workers.dev';
const OCR_MODEL  = '@cf/meta/llama-3.2-11b-vision-instruct';

// ---------- passphrase (never hardcoded; prompted or env) ----------
function getPassphrase() {
  const env = process.env.LETTER_PASSPHRASE;
  if (env && env.trim()) return env;
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question('passphrase for the jar (not stored; hidden input) > ', (ans) => {
      rl.close();
      if (!ans) { console.error('a passphrase is required'); process.exit(2); }
      resolve(ans);
    });
  });
}

// encrypt/decrypt helpers delegated to tools/encrypt-letter.js (single source
// of truth for the crypto — keeps the webcrypto params in exactly one place).
function encDecrypt(jsonText, passphrase, dir) {
  const res = spawnSync(process.execPath, ['tools/encrypt-letter.js', dir], {
    cwd: path.resolve(__dirname, '..'),
    input: jsonText,
    env: { ...process.env, LETTER_PASSPHRASE: passphrase },
    encoding: 'utf8'
  });
  if (res.status !== 0) { console.error('encryption tool failed:', res.stderr); process.exit(1); }
  return res.stdout;
}

const letterId = process.argv[2];
const author   = process.argv[3] || 'jennerino';
const emoji    = process.argv[4] || '💌';

if (!letterId) {
  console.error('Usage: node tools/publish-letter.js <letterId> [jennerino|dannerino] [emoji]');
  process.exit(1);
}

const repoRoot   = path.resolve(__dirname, '..');
const lettersDir = path.join(repoRoot, 'data', 'letters');
const txtPath    = path.join(lettersDir, `${letterId}.typed.txt`);
const jsonPath   = path.join(repoRoot, 'data', 'letters.json');

const isPublishMode = fs.existsSync(txtPath);

if (isPublishMode) {
  const raw = fs.readFileSync(txtPath, 'utf8');
  if (!raw.trim()) {
    console.error('Review file is empty — fill in data/letters/' + letterId + '.typed.txt and re-save.');
    process.exit(1);
  }

  // ignore our own "//" instruction lines when building the typed blocks
  const reviewed = raw.split('\n').filter(l => !l.startsWith('//')).join('\n').trim();

  // blank line separated paragraphs -> typed blocks
  const blocks = reviewed
    .split(/\n\s*\n/)
    .filter(s => s.trim())
    .map(p => ({ t: 'p', c: p.trim() }));

  if (blocks.length === 0) { console.error('No paragraphs found in review file.'); process.exit(1); }

  (async function publish() {
    const passphrase = await getPassphrase();
    const entry = { id: letterId, author, emoji, continues: false, blocks };

    if (!fs.existsSync(jsonPath)) {
      console.error('data/letters.json not found — nothing to add the letter to.');
      process.exit(1);
    }
    const encrypted = fs.readFileSync(jsonPath, 'utf8');

    // decrypt -> add letter -> re-encrypt
    const plaintext = encDecrypt(encrypted, passphrase, 'decrypt');
    let data;
    try { data = JSON.parse(plaintext); }
    catch (e) { console.error('❌ Couldn’t decrypt letters.json — wrong passphrase? ' + e.message); process.exit(1); }

    const existing = (data.letters || []).find(l => l.id === letterId);
    if (existing) Object.assign(existing, entry);
    else (data.letters = data.letters || []).push(entry);

    const reEncrypted = encDecrypt(JSON.stringify(data, null, 2), passphrase, 'encrypt');
    fs.writeFileSync(jsonPath, reEncrypted, 'utf8');

    const jar = author === 'dannerino' ? 'Jennerino' : 'Dannerino';
    console.log('\n✅ Published typed letter into data/letters.json (re-encrypted)');
    console.log('   author = ' + author + '  ->  ' + jar + "'s jar");
    console.log('   blocks =', blocks.length);
    console.log('\n📦 Commit + publish:');
    console.log('   git add data/letters.json');
    console.log('   git commit -m "Add typed letter ' + letterId + '"');
    console.log('   git push     # site updates in ~30s');
  })().catch(e => { console.error(e); process.exit(1); });
  return;
}

// ---- Run #1: OCR ----
(async function ocr() {
  const url = WORKER_URL + '/ocr?letterId=' + encodeURIComponent(letterId) + '&model=' + encodeURIComponent(OCR_MODEL);
  console.log('OCR-ing "' + letterId + '" with Llama-3.2-11b-vision ...');

  let resp;
  try {
    const raw = execSync('curl -s --max-time 120 "' + url + '"', { encoding: 'utf8' });
    resp = JSON.parse(raw);
  } catch (e) {
    console.error('curl failed:', e.message);
    process.exit(1);
  }
  if (!resp.ok) { console.error('OCR failed:', resp.error); process.exit(1); }

  const text = (resp.results || []).map(r => r.text || '').join('\n\n---\n\n').trim();

  fs.mkdirSync(lettersDir, { recursive: true });
  const seed = [
    '// 👀 YOU ARE HERE: Review this file.',
    '// --- Fix any OCR slip-ups, adjust paragraph breaks (blank line = new paragraph).',
    '// --- Then SAVE this file and re-run the SAME command to publish:',
    '//     node tools/publish-letter.js ' + letterId + ' ' + author + ' ' + emoji,
    '// --- Source photo folder: ' + resp.folder,
    '',
    text,
    ''
  ].join('\n');

  fs.writeFileSync(txtPath, seed, 'utf8');

  console.log('\n✏️  OCR done. Please open and review:');
  console.log('   ' + txtPath);
  console.log('\nWhen satisfied, re-save the file and run again:');
  console.log('   node tools/publish-letter.js ' + letterId + ' ' + author + ' ' + emoji);
})();
