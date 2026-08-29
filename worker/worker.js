// Cloudflare Worker -- "letter inbox" relay + handwriting OCR
// Receives letter uploads from the site and commits them to the GitHub repo.
// Also exposes an /ocr endpoint that transcribes a letter's image pages to
// text via Workers AI (Llama 3.2 vision) -- used to "transcribe uploaded
// letters into the jar" instead of showing the raw photo.
//
// Secrets / config:
//   GITHUB_TOKEN  (required) -- fine-grained PAT, repo-scoped to DandyAndJenny,
//                              permission "Contents: Read and write"
//   OCR_MODEL      (optional) -- Workers AI vision model id (see wrangler.toml)
//
// Bindings (declared in wrangler.toml):
//   AI  -- Workers AI binding, exposed as `env.AI`
//
// Endpoints:
//   GET  /health                          --> "ok"
//   POST /upload                          --> commit uploaded letter files to GitHub
//   GET  /ocr?letterId=<id>               --> transcribe a letter's images to text
//                                             (query: &model=<alternate-model>)
//   GET  /pending                         --> letterIds uploaded but not yet in the jar
//   POST /publish                         --> commit a new encrypted data/letters.json
//                                             (body: letterId, author, emoji, cipherText)
//                                             optional gate: Worker secret PUBLISH_PIN,
//                                             sent by the browser as "X-Publish-Pin"

const REPO   = "hwdan01/DandyAndJenny";
const BRANCH = "main";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Publish-Pin"
};

const OCR_MODEL_DEFAULT = "@cf/llava-hf/llava-1.5-7b-hf";

// Prompt tuned so the model emits ONLY text between START / END markers.
// We then extract that block, so preamble/commentary is discarded.
const OCR_PROMPT =
  "Read the handwriting in this image and transcribe it VERBATIM. " +
  "Return ONLY the handwritten words exactly as written, in order, " +
  "preserving original spelling, punctuation, capitalization, any emoji or " +
  "symbols, and paragraph / line breaks. If you see section labels or headers " +
  "written in the text, keep them inline as part of the flow. " +
  "Do NOT add introductions, explanations, markdown headings, commentary, or " +
  "notes. Do not correct typos. " +
  "Begin your response with exactly the line START and end with exactly the " +
  "line END, with the transcribed text between them and NO other content " +
  "anywhere in your response.";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}

// Unicode-safe base64 -- btoa() alone fails on emoji / non-Latin1 characters.
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function gitHeaders(env, contentType) {
  const h = {
    "User-Agent": "ourloveletters-worker",
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Health check
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200, headers: CORS });
    }

    // Upload
    if (request.method === "POST" && url.pathname === "/upload") {
      return handleUpload(request, env);
    }

    // OCR (experimental)
    if (request.method === "GET" && url.pathname === "/ocr") {
      return handleOcr(url, env);
    }

    // Letters waiting in the inbox (uploaded, not yet sealed into the jar)
    if (request.method === "GET" && url.pathname === "/pending") {
      return handlePending(env);
    }

    // Commit a new encrypted data/letters.json that was built in the browser
    if (request.method === "POST" && url.pathname === "/publish") {
      return handlePublish(request, env);
    }

    return new Response("not found", { status: 404, headers: CORS });
  }
};

async function handleUpload(request, env) {
  try {
    const body = await request.json();
    const { letterId, pages, manifest } = body;

    if (!letterId || !Array.isArray(pages) || pages.length === 0) {
      return json({ ok: false, error: "missing letterId or pages" }, 400);
    }

    const results = [];

    for (const p of pages) {
      if (!p.name || !p.base64) continue;
      const path = `data/inbox/${letterId}/${p.name}`;
      const res = await putFile(env, path, p.base64, `Add letter ${letterId} (${p.name})`);
      results.push({ path, status: res.status, detail: res.detail });
    }

    const manifestPath = `data/inbox/${letterId}/manifest.json`;
    const manifestB64 = b64encode(JSON.stringify(manifest || {}));
    const mres = await putFile(env, manifestPath, manifestB64, `Add letter ${letterId} manifest`);
    results.push({ path: manifestPath, status: mres.status, detail: mres.detail });

    const ok = results.every(r => r.status >= 200 && r.status < 300);
    return json({ ok, results });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function putFile(env, path, base64Content, message) {
  const url = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const headers = gitHeaders(env, "application/json");

  let body = { message, content: base64Content, branch: BRANCH };
  const existing = await fetch(url, { headers });
  if (existing.status === 200) {
    const data = await existing.json();
    body.sha = data.sha;
  }

  const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
  let detail = "";
  try {
    const data = await res.json();
    detail = data.message || "";
  } catch (e) { /* non-JSON response */ }
  return { status: res.status, detail };
}

// --- OCR (experimental) ---
// Lists a letter's image files on GitHub, runs a Workers AI vision model
// over each page, and returns the transcribed text.
async function handleOcr(url, env) {
  try {
    const letterId = url.searchParams.get("letterId");
    if (!letterId) return json({ ok: false, error: "missing letterId" }, 400);

    // Resolve the letter's folder: try data/letters/{id} first, then data/inbox/{id}
    let folder = `data/letters/${letterId}`;
    let files = await listFolder(env, folder);
    if (!files) {
      folder = `data/inbox/${letterId}`;
      files = await listFolder(env, folder);
    }
    if (!files) return json({ ok: false, error: "letter folder not found" }, 404);

    const images = files.filter(f => /\.(jpe?g|png|webp)$/i.test(f.name));
    if (images.length === 0) return json({ ok: false, error: "no image files in letter folder" }, 404);

    if (!env.AI) return json({ ok: false, error: "Workers AI binding 'AI' not configured" }, 500);

    // `model` query param lets you test alternatives without redeploying
    const model = url.searchParams.get("model") || env.OCR_MODEL || OCR_MODEL_DEFAULT;
    const results = [];

    for (const img of images) {
      const imgRes = await fetch(img.download_url, { headers: gitHeaders(env) });
      if (!imgRes.ok) {
        results.push({ file: img.name, error: "image fetch failed HTTP " + imgRes.status });
        continue;
      }
      const bytes = new Uint8Array(await imgRes.arrayBuffer());

      // `runAi` auto-accepts Llama license-gated models (prompt "agree") on first use.
      const out = await runAi(env, model, { image: [...bytes], prompt: OCR_PROMPT, max_tokens: 4000 });
      const text =
        typeof out === "string" ? out
          : (out && (out.response || out.description || out.answer))
            ? (out.response || out.description || out.answer)
            : JSON.stringify(out);

      results.push({ file: img.name, model, text: cleanOcrText(text) });
    }

    return json({ ok: true, letterId, folder, results });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// Extract only the text between START / END markers, discarding preamble/notes.
function cleanOcrText(text) {
  let t = String(text);
  const s = t.indexOf("START");
  const e = t.indexOf("END");
  if (s !== -1 && e !== -1 && e > s) {
    t = t.slice(s + 5, e);
  }
  return t.trim();
}

// Run an AI model, auto-accepting license-gated models (e.g. Llama 3.2
// vision) on first use by submitting the prompt "agree" and retrying once.
let aiLicenseAgreed = {};
async function runAi(env, model, inputs) {
  try {
    return await env.AI.run(model, inputs);
  } catch (e) {
    const msg = String(e);
    if ((msg.includes("5016") || msg.includes("5073") || msg.includes("agree")) && !aiLicenseAgreed[model]) {
      aiLicenseAgreed[model] = true;
      try { await env.AI.run(model, { prompt: "agree", max_tokens: 1 }); } catch (g) { /* ignore */ }
      return await env.AI.run(model, inputs);
    }
    throw e;
  }
}

// Returns the GitHub contents listing for a folder, or null if it doesn't exist.
async function listFolder(env, path) {
  const url = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const res = await fetch(url, { headers: gitHeaders(env) });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) ? data : null;
}

// --- Jar Studio: publish + pending ---
// The BROWSER does the crypto: it decrypts data/letters.json with the
// passphrase (which never leaves the browser), appends the reviewed letter,
// re-encrypts, and POSTs the new ciphertext here. This endpoint only commits
// bytes to GitHub -- it never sees the passphrase, so only someone who has
// unlocked the jar can produce ciphertext that readers can decrypt.

async function handlePublish(request, env) {
  try {
    const body = await request.json();
    const { letterId, author, emoji, cipherText, baseSha } = body;

    if (!letterId || !cipherText) return json({ ok: false, error: "missing letterId or cipherText" }, 400);
    if (author !== "jennerino" && author !== "dannerino") {
      return json({ ok: false, error: "author must be jennerino or dannerino" }, 400);
    }
    let parsed;
    try { parsed = JSON.parse(cipherText); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed.iv !== "string" || typeof parsed.ct !== "string") {
      return json({ ok: false, error: "cipherText does not look like {iv,ct} ciphertext" }, 400);
    }

    // Optional shared-PIN gate. The PIN lives in a Worker secret and in the
    // couple's browsers (localStorage) -- never in the repo or site source.
    if (env.PUBLISH_PIN) {
      const pin = request.headers.get("x-publish-pin") || "";
      if (pin !== env.PUBLISH_PIN) {
        return json({ ok: false, error: "publish pin required", needsPin: true }, 401);
      }
    }

    // Conflict check: if the caller edited an older letters.json, refuse
    // rather than silently clobbering the other person's letter.
    const current = await getFileMeta(env, "data/letters.json");
    if (current && baseSha && current.sha !== baseSha) {
      return json({ ok: false, error: "letters.json changed since you loaded it", conflict: true, currentSha: current.sha }, 409);
    }

    const put = await putFile(env, "data/letters.json", b64encode(cipherText),
      `Add letter ${letterId} to the jar (${author})`);
    if (put.status < 200 || put.status >= 300) {
      return json({ ok: false, error: "commit failed: " + (put.detail || put.status), results: [put] }, 502);
    }

    // Best-effort cleanup: the inbox bundle has been transcribed into the jar.
    const deleted = await deleteFolder(env, `data/inbox/${letterId}`);

    return json({ ok: true, put, deleted });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// Lists letterIds that have an inbox bundle with a manifest (uploaded, not yet sealed).
async function handlePending(env) {
  try {
    const dirs = await listFolder(env, "data/inbox");
    if (!dirs) return json({ ok: true, pending: [] });
    const pending = [];
    for (const f of dirs) {
      if (f.type !== "dir") continue;
      const inner = await listFolder(env, `data/inbox/${f.name}`);
      if (inner && inner.some(x => x.name === "manifest.json")) pending.push(f.name);
    }
    return json({ ok: true, pending });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// Fetches a file's metadata (sha etc.) from the repo, or null if absent.
async function getFileMeta(env, path) {
  const url = `https://api.github.com/repos/${REPO}/contents/${path}?ref=${BRANCH}`;
  const res = await fetch(url, { headers: gitHeaders(env) });
  if (!res.ok) return null;
  return await res.json();
}

// Deletes one file (needs its current sha). Returns {status, detail}.
async function deleteFile(env, path, message) {
  const url = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const headers = gitHeaders(env, "application/json");
  const existing = await fetch(url, { headers });
  if (existing.status === 404) return { status: 404, detail: "already gone" };
  if (!existing.ok) return { status: existing.status, detail: "lookup failed" };
  const data = await existing.json();
  const res = await fetch(url, { method: "DELETE", headers, body: JSON.stringify({ message, sha: data.sha, branch: BRANCH }) });
  let detail = "";
  try { detail = (await res.json()).message || ""; } catch (e) { /* non-JSON */ }
  return { status: res.status, detail };
}

// Deletes every file in a folder (GitHub drops the folder once it is empty).
async function deleteFolder(env, path) {
  const files = await listFolder(env, path);
  if (!files) return [];
  const out = [];
  for (const f of files) {
    out.push({ path: `${path}/${f.name}`, ...(await deleteFile(env, `${path}/${f.name}`, `Remove transcribed letter file ${f.name}`)) });
  }
  return out;
}
