// Cloudflare Worker — "letter inbox" relay
// Receives letter uploads from the site and commits them to the GitHub repo.
//
// Secrets (set in Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   GITHUB_TOKEN  (required) — fine-grained PAT, repo-scoped to DandyAndJenny,
//                              permission "Contents: Read and write"
//
// Endpoints:
//   POST /upload   body: { letterId, pages:[{name, base64}], manifest }  → commits files
//   GET  /health   → "ok"
//
// The Worker URL is public (not a secret). The GitHub token never leaves this Worker.

const REPO   = "hwdan01/DandyAndJenny";
const BRANCH = "main";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}

// Unicode-safe base64 — btoa() alone fails on emoji / non-Latin1 characters
// (e.g. the letter's emoji in the manifest).
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight (the site lives on a different origin)
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

    // Commit each page image
    for (const p of pages) {
      if (!p.name || !p.base64) continue;
      const path = `data/inbox/${letterId}/${p.name}`;
      const res = await putFile(env, path, p.base64, `Add letter ${letterId} (${p.name})`);
      results.push({ path, status: res.status, detail: res.detail });
    }

    // Commit the manifest
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
  const headers = {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  // If the file already exists, GitHub needs its sha to overwrite it.
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