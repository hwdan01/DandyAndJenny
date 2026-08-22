// One-time Phase 0 helper: extracts the inline `pages` + `continues` arrays
// from index.html and writes them to data/letters.json.
const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');

const m = html.match(/var pages = (\[[\s\S]*?\]);\s*\n\s*var continues = (\[[^\]]*\]);/);
if (!m) { console.error('Could not find pages/continues arrays'); process.exit(1); }

const pages = eval(m[1]);
const continues = eval(m[2]);

if (pages.length !== 6) { console.error('Unexpected page count:', pages.length); process.exit(1); }

const letters = pages.map((p, i) => ({
  emoji: p.emoji,
  continues: continues[i],
  blocks: p.blocks
}));

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/letters.json', JSON.stringify({ letters }, null, 2) + '\n');

console.log('Wrote data/letters.json with', letters.length, 'letters');
console.log('Block counts per letter:', letters.map(l => l.blocks.length).join(', '));