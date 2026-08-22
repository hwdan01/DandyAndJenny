# Security Review — The Love Letter Site

**Session saved:** (current date)
**Project:** `C:\Users\weida\OneDrive\Desktop\love-letter-site`
**Live site:** https://hwdan01.github.io/DandyAndJenny/
**GitHub repo:** https://github.com/hwdan01/DandyAndJenny

---

## 1. Current State (as of this session)

- Site is a single self-contained `index.html` (inline CSS + JS, no external assets).
- Hosted on **GitHub Pages (free plan)** → requires a **public** repository.
- A **client-side passcode lock** was added (lock screen overlay + `LOCK_PASSCODE` variable in the script).
- A `<meta name="robots" content="noindex, nofollow">` tag was added to block search-engine indexing.

---

## 2. Key Security Findings

### ⚠️ The passcode is currently visible in the source code
- The passcode sits in plain text in `index.html`:
  ```js
  var LOCK_PASSCODE = "yourpassword";
  ```
- Because GitHub Pages serves the file publicly, **anyone with the link can view the full source** (right-click → View Page Source / `Ctrl+U`) and read the passcode.
- **Conclusion:** The current lock is a *deterrent*, not real security. It stops casual visitors but not anyone who can view source.

### ⚠️ GitHub Pages free plan cannot be made private
- On GitHub's **free plan**, GitHub Pages only works with **public** repositories.
- Making the repo private **takes the site offline** (404) unless upgraded to **GitHub Pro ($4/month)**.

### ✅ What IS already protected
- Search engines (Google/Bing) are blocked from listing the site via the `noindex` tag.
- Casual visitors are stopped by the passcode screen.

---

## 3. Recommended Fix (not yet implemented)

**Client-side encryption** is the only real workaround that keeps free GitHub Pages while protecting the letters:

- Encrypt the six letters inside `index.html` (AES encryption).
- The file contains only scrambled ciphertext — viewing source reveals nothing readable.
- The passcode is **never stored in the file**; it only exists in the user's head.
- The browser decrypts the letters in memory after the correct passcode is entered.

### Honest limits of this approach
| Item | Status |
|---|---|
| Letters readable without passcode? | No — unreadable gibberish |
| Passcode findable in source? | No — not in the file |
| Site URL stays public? | Yes — do not share the link publicly |
| Google/Bing listing? | Blocked (noindex) |
| Brute-force resistant? | Only with a strong passphrase |
| Names (Dannerino/Jennerino) visible in source? | Yes — only the letters are protected |

---

## 4. Alternative Options Considered

| Option | Cost | Real privacy? |
|---|---|---|
| **Netlify + server-side password** | Free | ✅ Yes (recommended if leaving GitHub Pages) |
| **GitHub Pro + private repo** | $4/month | ⚠️ URL still public; no true lock |
| **Keep public + in-page passcode** | Free | ❌ Not real security |
| **Client-side encryption on GitHub Pages** | Free | ✅ Yes (recommended if staying on GitHub Pages) |

---

## 5. Pending Action

- [ ] User to provide the desired **passcode**.
- [ ] Implement client-side encryption of the letter contents in `index.html`.
- [ ] Test encrypt/decrypt round-trip.
- [ ] Re-upload `index.html` to GitHub.
- [ ] (Optional) Decide whether to keep the in-page lock as a fun extra layer or remove it.

---

## 6. Reminder for the User

- **Do not post the live URL publicly** — the link itself is the only thing keeping strangers away.
- Choose a **strong passcode** (a phrase with numbers/spaces is far better than a single word).
- If you ever want *true* server-side protection, move hosting to Netlify (free) — I can walk you through it.