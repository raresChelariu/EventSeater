/**
 * Shared plan storage — Cloudflare Pages Function, served at /api/plan.
 *
 * Setup (once, in the Cloudflare dashboard):
 *
 *   1. Workers & Pages -> KV -> Create a namespace, e.g. "placecard"
 *   2. Your Pages project -> Settings -> Bindings -> Add KV namespace
 *      Variable name: PLAN        Namespace: the one from step 1
 *   3. Same Settings page -> Environment variables -> Add
 *      Name: EDIT_KEY             Value: a passphrase, marked as a Secret
 *   4. Redeploy
 *
 * Both reads and writes require the passphrase. This is a guest list with
 * photographs of real people sitting on a public URL, so an open GET would
 * publish it to anyone who guessed the address. Without the passphrase the
 * app still runs, backed by the browser's own storage.
 *
 * Concurrency is compare-and-set on a version counter: a PUT states the
 * version it was built from, and is rejected with 409 if the stored plan has
 * moved on. KV is eventually consistent across regions, so this narrows the
 * window rather than closing it - fine for two people, not for twenty.
 */

const KEY = "plan";
const MAX_BYTES = 20 * 1024 * 1024;

function json(body, status){
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

async function sha256(s){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(buf);
}

/** Compare digests, not the strings — equal length, no early exit, no length leak. */
async function sameSecret(a, b){
  if (typeof a !== "string" || typeof b !== "string") return false;
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function guard(request, env){
  if (!env.PLAN) return json({ error: "no_kv_binding" }, 500);
  if (!env.EDIT_KEY) return json({ error: "no_edit_key" }, 500);
  const supplied = request.headers.get("x-plan-key") || "";
  if (!(await sameSecret(supplied, env.EDIT_KEY))) return json({ error: "unauthorized" }, 401);
  return null;
}

export async function onRequestGet({ request, env }){
  const bad = await guard(request, env);
  if (bad) return bad;

  const raw = await env.PLAN.get(KEY);
  if (!raw) return json({ version: 0, updatedAt: 0, data: null });

  // Stored verbatim, so hand it back verbatim rather than parsing a few MB.
  return new Response(raw, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export async function onRequestPut({ request, env }){
  const bad = await guard(request, env);
  if (bad) return bad;

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) return json({ error: "too_large" }, 413);

  let body;
  try { body = await request.json(); }
  catch (e){ return json({ error: "bad_json" }, 400); }

  if (!body || typeof body !== "object" || !body.data || typeof body.data !== "object"){
    return json({ error: "bad_body" }, 400);
  }

  const stored = await env.PLAN.get(KEY);
  const current = stored ? JSON.parse(stored) : null;
  const currentVersion = current ? (current.version || 0) : 0;
  const base = Number(body.baseVersion) || 0;

  if (base !== currentVersion){
    return json({ error: "conflict", version: currentVersion }, 409);
  }

  const next = JSON.stringify({
    version: currentVersion + 1,
    updatedAt: Date.now(),
    data: body.data
  });
  if (next.length > MAX_BYTES) return json({ error: "too_large" }, 413);

  await env.PLAN.put(KEY, next);
  return json({ version: currentVersion + 1, updatedAt: Date.now() });
}

export function onRequest(){
  return json({ error: "method_not_allowed" }, 405);
}
