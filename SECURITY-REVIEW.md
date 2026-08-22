# Security Review — The Love Letter Site

**Project:** `C:\Users\weida\OneDrive\Desktop\love-letter-site`
**Live site:** https://hwdan01.github.io/DandyAndJenny/
**GitHub repo:** https://github.com/hwdan01/DandyAndJenny

---

## 1. Where it stands

- Site is a single self-contained `index.html` (inline CSS + JS, no external assets).
- Hosted on **GitHub Pages (free plan)** → the repo must stay **public**.
- `data/letters.json` is stored on the repo **encrypted at rest**. The letters are only decrypted in the visitor's browser, in memory.

## 2. How the letters are protected

- **Encryption:** AES-256-GCM. The encryption key is derived in the browser
  from a **passphrase** the recipient types, using PBKDF2-HMAC-SHA256
  (600,000 iterations). The salt is a fixed constant shared with
  `tools/encrypt-letter.js` (salt is not secret; it just defeats pre-built tables).
- **The passphrase is never in the repo.** It is not hardcoded in `index.html`,
  the tools, or any commit history. The visitor types it on the lock screen; a
  correct entry makes `data/letters.json` decrypt successfully (and the jars
  appear), a wrong entry fails AES-GCM authentication → the letters stay sealed.
- **Ciphertext only:** anyone viewing the raw source or `data/letters.json`
  sees only `{ "iv": "...", "ct": "..." }` — unreadable gibberish.

## 3. Honest limits (read this if you change the passphrase)

| Question | Answer |
|---|---|
| Letters readable without the passphrase? | No — unreadable ciphertext |
| Passphrase findable in the repo? | No — not anywhere in source or history |
| Site URL private? | No — the link itself is the only gate |
| Google/Bing listing? | Blocked via `<meta name="noindex, nofollow">` |
| Brute-force of a weak passphrase? | Possible. A short or all-numeric passphrase is weak. |
| Names (Dannerino/Jennerino) visible? | Yes — only the letter *contents* are protected |

**Recommendation:** if the passphrase is a short or all-numeric value, treat it as a
convenience code rather than strong security. You can rotate to a stronger passphrase at any time:

```bash
LETTER_PASSPHRASE=<old> node tools/encrypt-letter.js rotate <new>
# then: git add data/letters.json && git commit && git push
```

Only `data/letters.json` (ciphertext) is rewritten; the letters keep their content
but change key. If you ever want *true* server-side protection, move hosting to
Netlify (free) — happy to walk you through it.

## 4. How a letter gets added (encrypted workflow)

1. Upload a photo from the site's "✎ add a letter" button → it lands in
   `data/inbox/<letterId>/` via the Cloudflare Worker.
2. `node tools/publish-letter.js <letterId> <author> <emoji>` OCRs it (Worker AI),
   writes `data/letters/<letterId>.typed.txt` for you to **review**.
3. Re-run the same command → it **decrypts** `data/letters.json`, adds the typed
   letter, **re-encrypts** it, and writes it back (still ciphertext). Then:
   ```bash
   git add data/letters.json
   git commit -m "Add typed letter <letterId>"
   git push     # live site updates in ~30s, still encrypted
   ```
4. Review files (`data/letters/*.typed.txt`), photos (`data/inbox/*`), and the
   `.bundle` backups are git-ignored and never committed.

## 5. History

The repo's history was rewritten once to scrub plaintext: every historical
`data/letters.json` and `index.html` was replaced with ciphertext, and uploaded
photos + old transcripts were expunged. The passphrase does not appear in any
commit. A local backup bundle (`backups/main-before-encryption.bundle`) holds the
pre-scrub state for recovery if ever needed.
