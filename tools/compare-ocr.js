// Compare an OCR transcript against the typed letters already in the jar.
// Usage: node tools/compare-ocr.js <ocr-json> <letter-json> <letterIndex...>
//   e.g. node tools/compare-ocr.js backups/ocr-out11b.json data/letters.json 1 2
//
// The OCR output is a JSON like { results: [{ file, text, ... }] }.
// We check whether the OCR text is contained in (or equal to) the concatenated
// block text of the named jar letters -- i.e. whether this photo is the
// handwritten source of already-typed letters, or a genuinely new letter.

const fs = require('fs');

const ocr = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const letters = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).letters;
const indices = process.argv.slice(4).map(Number);

// Grab the OCR text block(s)
const ocrText = (ocr.results || []).map(r => (r.text || '')).join('\n\n').trim();

// Concatenate target jar letters' text
function blockText(b) {
  if (b.t === 'ol') return (b.items || []).join(' ');
  return b.c || '';
}
const jarText = indices.map(i => {
  const l = letters[i];
  if (!l) return '';
  return l.blocks.map(blockText).join(' ');
}).join(' ');

// Normalise for fuzzy matching: strip HTML entities, lowercase, collapse
// whitespace, then keep only alnum + basic punctuation + space.
function norm(s) {
  return s
    .replace(/&(?:#\d+|[a-z]+);/gi, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ,.?!'-]/g, '')
    .trim();
}
const nOcr = norm(ocrText);
const nJar = norm(jarText);

const isSubstring = nOcr && nJar.includes(nOcr);

// Token-overlap similarity (Jaccard-style over whitespace tokens)
const toksOcr = nOcr.split(' ').filter(Boolean);
const toksJar = nJar.split(' ').filter(Boolean);
const setOcr = new Set(toksOcr);
const setJar = new Set(toksJar);
let inter = 0;
for (const t of setOcr) if (setJar.has(t)) inter++;
const union = new Set([...toksOcr, ...toksJar]).size;
const jaccard = union ? (inter / union * 100) : 0;

console.log('OCR length (chars):', ocrText.length);
console.log('Jar letters[' + indices.join(',') + '] length (chars):', jarText.length);
console.log('OCR text is a substring of jar text:', isSubstring);
console.log('OCR vs jar Jaccard token similarity:', jaccard.toFixed(1) + '%');
console.log('\n--- OCR first 260 chars ---\n' + ocrText.slice(0, 260));
console.log('\n--- Jar letters[' + indices.join(',') + '] first 260 chars ---\n' + jarText.slice(0, 260));
console.log('\n--- OCR last 140 chars ---\n' + ocrText.slice(-140));
console.log('\n--- Jar letters[' + indices.join(',') + '] chars @ OCR-end region ---\n' + nJar.slice(nOcr.length - 120, nOcr.length + 40));
