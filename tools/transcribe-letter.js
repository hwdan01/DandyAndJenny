// Phase 3: transcribe an uploaded letter bundle from data/inbox/{letterId}/
// into the jar (data/letters.json) so it appears as a new envelope.
//
// Usage:  node tools/transcribe-letter.js <letterId>
//   e.g.  node tools/transcribe-letter.js letter-20260823-115201
//
// What it does:
//   1. Reads data/inbox/{letterId}/manifest.json
//   2. Copies page images from data/inbox/{letterId}/ to data/letters/{letterId}/
//      (data/letters/ is NOT gitignored, so the images get committed with the site)
//   3. Appends a letter entry to data/letters.json as image blocks
//   4. Removes the inbox bundle (it's now safely in the jar)
//
// Caveat: inbox files committed by the Worker stay tracked in git even though
// data/inbox/ is gitignored — after removal, run `git add -A` then commit,
// or the stale inbox files will resurface on the next pull.
const fs = require('fs');
const path = require('path');

const letterId = process.argv[2];
if (!letterId) {
  console.error('Usage: node tools/transcribe-letter.js <letterId>');
  process.exit(1);
}

const inboxDir = path.join('data', 'inbox', letterId);
const manifestPath = path.join(inboxDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('No manifest at ' + manifestPath);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const pages = manifest.pages || [];
if (!pages.length) {
  console.error('Manifest has no pages');
  process.exit(1);
}

// 1. Copy images into data/letters/{letterId}/
const destDir = path.join('data', 'letters', letterId);
fs.mkdirSync(destDir, { recursive: true });

const blocks = pages.map((p, i) => {
  const rel = path.join('data', 'letters', letterId, p.file).replace(/\\/g, '/');
  const from = path.join(inboxDir, p.file);
  if (!fs.existsSync(from)) {
    console.error('Missing page file: ' + from);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(destDir, p.file));
  return { t: 'img', src: rel, alt: 'page ' + (i + 1) };
});

// 2. Append the letter to the jar
const lettersPath = path.join('data', 'letters.json');
const data = JSON.parse(fs.readFileSync(lettersPath, 'utf8'));
if (data.letters.some(l => l.id === letterId)) {
  console.error('Letter ' + letterId + ' is already in the jar — aborting');
  process.exit(1);
}
data.letters.push({
  id: letterId,
  author: manifest.author || 'jennerino',
  emoji: manifest.emoji || '💌',
  continues: false,
  blocks
});
fs.writeFileSync(lettersPath, JSON.stringify(data, null, 2) + '\n');

// 3. Remove the inbox bundle (staging area is now empty)
fs.rmSync(inboxDir, { recursive: true, force: true });

console.log('✓ Transcribed ' + letterId + ' into the jar (' + pages.length + ' image page(s))');
console.log('✓ Inbox bundle removed');
console.log('Jar now has ' + data.letters.length + ' letters');