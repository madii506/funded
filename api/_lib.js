// FUNDED's shared server code. Every upstream call has a timeout and an honest failure message.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const SOL = 'So11111111111111111111111111111111111111112';
const RPCS = (process.env.RPC_URLS || process.env.RPC_URL || 'https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com').split(',').map(s => s.trim()).filter(Boolean);
const MOCK = process.env.F_MOCK ? require(process.env.F_MOCK) : null;   // dev only: canned upstreams

function send(res, code, obj, cache = 'no-store') {
  res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (/s-maxage/.test(cache)) { res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate'); res.setHeader('CDN-Cache-Control', cache.replace(/max-age=0,\s*/, '')); }
  else res.setHeader('Cache-Control', cache);
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'content-type'); res.end(JSON.stringify(obj));
}
const CACHE = (s, swr = s * 6) => `public, max-age=0, s-maxage=${s}, stale-while-revalidate=${swr}`;
function query(req) { if (req.query) return req.query; return Object.fromEntries(new URL(req.url, 'http://x').searchParams); }
async function body(req, max = 64 * 1024) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { if (req.body.length > max) return { tooBig: true }; try { return JSON.parse(req.body); } catch { return {}; } }
  if (Buffer.isBuffer(req.body)) { if (req.body.length > max) return { tooBig: true }; try { return JSON.parse(req.body.toString('utf8')); } catch { return {}; } }
  const chunks = []; let n = 0; for await (const c of req) { chunks.push(c); n += c.length; if (n > max) return { tooBig: true }; }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}
function ip(req) { return String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '?').split(',')[0].trim(); }
const hits = new Map();
function limited(key, n, ms) { const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < ms); a.push(now); hits.set(key, a); if (hits.size > 5000) hits.delete(hits.keys().next().value); return a.length > n; }

async function getJson(url, opt = {}, ms = 9000) {
  if (MOCK) return MOCK.fetch(url, opt);
  const r = await fetch(url, { ...opt, headers: { 'user-agent': UA, accept: 'application/json', ...(opt.headers || {}) }, signal: AbortSignal.timeout(ms) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, ok: r.ok, json: j, text: t };
}
async function rpcRaw(method, params, ms = 12000) {
  if (MOCK && MOCK.rpc) return MOCK.rpc(method, params);
  let last;
  for (const u of RPCS) {
    try {
      const r = await getJson(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, ms);
      if (r.json && (r.json.result !== undefined || (r.json.error && (method === 'sendTransaction' || method === 'simulateTransaction')))) return r.json;
      last = new Error((r.json && r.json.error && r.json.error.message) || 'rpc ' + r.status);
    } catch (e) { last = e; }
  }
  throw last || new Error('rpc failed');
}
async function rpc(method, params, ms) { const j = await rpcRaw(method, params, ms); if (j.error) throw new Error(j.error.message || 'rpc error'); return j.result; }
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch {} } })); }
const memo = new Map();
async function remember(key, ms, fn) {
  const m = memo.get(key); if (m && m.v !== undefined && Date.now() - m.at < ms) return m.v;
  if (m && m.p) return m.p;
  const p = fn().then(v => { memo.set(key, { at: Date.now(), v }); return v; }).catch(e => { if (m && m.v !== undefined) memo.set(key, m); else memo.delete(key); throw e; });
  memo.set(key, { ...(m || { at: 0 }), p }); return p;
}

// ---------- base58 and program-derived addresses without the SDK ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58enc(buf) {
  let n = 0n; for (const b of buf) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
function b58dec(str) {
  let n = 0n; for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of str) { if (c === '1') out.unshift(0); else break; }
  return Buffer.from(out);
}
const P25519 = (1n << 255n) - 19n;
const modp = a => ((a % P25519) + P25519) % P25519;
function powp(b, e) { let r = 1n; b = modp(b); while (e > 0n) { if (e & 1n) r = r * b % P25519; b = b * b % P25519; e >>= 1n; } return r; }
const D25519 = modp(-121665n * powp(121666n, P25519 - 2n));
const SQRTM1 = powp(2n, (P25519 - 1n) / 4n);
function onCurve(bytes) {
  const b = Buffer.from(bytes); b[31] &= 0x7f;
  let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) + BigInt(b[i]);
  if (y >= P25519) return false;
  const y2 = y * y % P25519, u = modp(y2 - 1n), v = modp(D25519 * y2 + 1n);
  const x2 = u * powp(v, P25519 - 2n) % P25519;
  if (x2 === 0n) return true;
  let x = powp(x2, (P25519 + 3n) / 8n);
  if (x * x % P25519 === x2) return true;
  x = x * SQRTM1 % P25519;
  return x * x % P25519 === x2;
}
const L58 = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
function pda(seeds, programId) {
  const crypto = require('crypto'); const prog = b58dec(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256');
    for (const sd of seeds) h.update(typeof sd === 'string' ? (L58(sd) ? b58dec(sd) : Buffer.from(sd)) : Buffer.from(sd));
    h.update(Buffer.from([bump])); h.update(prog); h.update(Buffer.from('ProgramDerivedAddress'));
    const k = h.digest(); if (!onCurve(k)) return b58enc(k);
  }
  throw new Error('no pda');
}
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const bondingCurveOf = mint => pda([Buffer.from('bonding-curve'), b58dec(mint)], PUMP);
const ataOf = (owner, mint, prog) => pda([b58dec(owner), b58dec(prog), b58dec(mint)], ATA);
const creatorVaultOf = creator => pda([Buffer.from('creator-vault'), b58dec(creator)], PUMP);
const ammVaultOf = creator => pda([Buffer.from('creator_vault'), b58dec(creator)], PUMP_AMM);
const RENT0 = 890880;
async function accounts(addrs) {
  if (MOCK && MOCK.accounts) return MOCK.accounts(addrs);
  const out = [];
  for (let i = 0; i < addrs.length; i += 100) {
    const r = await rpc('getMultipleAccounts', [addrs.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }]);
    for (const a of r.value) out.push(a ? { data: Buffer.from(a.data[0], 'base64'), lamports: a.lamports, owner: a.owner } : null);
  }
  return out;
}
const tokenAmount = acct => (acct && acct.data && acct.data.length >= 72 ? acct.data.readBigUInt64LE(64) : 0n);
const tokenOwner = acct => (acct && acct.data && acct.data.length >= 64 ? b58enc(acct.data.subarray(32, 64)) : null);
async function balance(addr) { if (MOCK && MOCK.balance) return MOCK.balance(addr); const r = await rpc('getBalance', [addr, { commitment: 'confirmed' }]); return Number(r.value || 0); }

// ---------- the database: Postgres (Neon on Vercel; PGlite in local dev) ----------
let pg = null, made = null;
async function q(text, params = []) {
  if (process.env.F_PGLITE) {
    if (!pg) { const { PGlite } = require('@electric-sql/pglite'); pg = new PGlite(process.env.F_PGLITE); }
    return (await pg.query(text, params)).rows;
  }
  if (!pg) { const { neon } = require('@neondatabase/serverless'); pg = neon(DBURL()); }
  return pg.query(text, params);
}
const DBURL = () => process.env.FUNDED_DB_DATABASE_URL || process.env.FUNDED_DB_POSTGRES_URL || process.env.FUNDED_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
const dbReady = () => !!(process.env.F_PGLITE || DBURL());
function ready() {
  if (!made) made = (async () => {
    for (const st of [
      `CREATE TABLE IF NOT EXISTS fu_meta (k text PRIMARY KEY, v text NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS fu_coins (id text PRIMARY KEY, n serial, wallet text UNIQUE NOT NULL, mint text UNIQUE NOT NULL, launcher text NOT NULL,
        name text NOT NULL, symbol text NOT NULL, description text NOT NULL DEFAULT '', twitter text, website text, img bytea, meta_uri text,
        trader text NOT NULL, trader_key text NOT NULL, trader_wallet text NOT NULL, deposit_svm text,
        dev_buy float8 NOT NULL, need bigint NOT NULL, state text NOT NULL DEFAULT 'waiting', err text,
        create_sig text, out_sig text, refund_sig text, created_at timestamptz NOT NULL DEFAULT now(), live_at timestamptz, ticked_at timestamptz,
        mcap_usd float8, complete boolean NOT NULL DEFAULT false, claimed bigint NOT NULL DEFAULT 0, paid bigint NOT NULL DEFAULT 0, cut bigint NOT NULL DEFAULT 0,
        burned bigint NOT NULL DEFAULT 0, payouts int NOT NULL DEFAULT 0, last_pay_at timestamptz)`,
      `CREATE INDEX IF NOT EXISTS fu_coins_state ON fu_coins(state, ticked_at)`,
      `CREATE INDEX IF NOT EXISTS fu_coins_trader ON fu_coins(trader_key, state)`,
      `CREATE TABLE IF NOT EXISTS fu_pay (n bigserial PRIMARY KEY, id text NOT NULL, to_addr text NOT NULL, lamports bigint NOT NULL, cut bigint NOT NULL DEFAULT 0,
        sig text NOT NULL, sol_usd float8, at timestamptz NOT NULL DEFAULT now(), bridge text, bridge_at timestamptz)`,
      `CREATE INDEX IF NOT EXISTS fu_pay_id ON fu_pay(id, n DESC)`,
      `CREATE TABLE IF NOT EXISTS fu_log (n bigserial PRIMARY KEY, id text, kind text NOT NULL, text text NOT NULL, sol float8, sig text, at timestamptz NOT NULL DEFAULT now())`,
      `CREATE INDEX IF NOT EXISTS fu_log_id ON fu_log(id, n DESC)`,
    ]) await q(st);
  })().catch(e => { made = null; throw e; });
  return made;
}
const log = (id, kind, text, extra = {}) => q('INSERT INTO fu_log (id, kind, text, sol, sig) VALUES ($1,$2,$3,$4,$5)',
  [id || null, kind, String(text).slice(0, 400), extra.sol == null ? null : extra.sol, extra.sig || null]).catch(() => {});

// ---------- words ----------
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
// what a public name, ticker or line may not say (the board, the tape and pump.fun all show them)
const BANNED = /\b(n[i1]gg\w*|f[a4]gg?\w*|kike|spic|chink|retard\w*|tranny|nazi|hitler|rape\w*|pedo\w*|cp|child\s*porn|isis|kkk)\b/i;
const isAddr = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const isSig = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(s);
function origin(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const h = req.headers['x-forwarded-host'] || req.headers.host || 'localhost'; const proto = req.headers['x-forwarded-proto'] || (/^localhost|^127\./.test(h) ? 'http' : 'https'); return proto + '://' + h;
}
const TREASURY = (process.env.FUNDED_TREASURY || '').trim();   // the $FUNDED treasury: its 10% of every payout goes here
const CUT_BPS = 1000;                                            // 10%. While FUNDED_TREASURY is unset nothing is taken: the trader gets 100%
const OPTED_OUT = new Set((process.env.OPT_OUT || '').split(',').map(s => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean));

module.exports = {
  UA, SOL, RPCS, MOCK, send, CACHE, query, body, ip, limited, getJson, rpc, rpcRaw, pool, remember,
  b58enc, b58dec, onCurve, pda, PUMP, PUMP_AMM, TOKEN, TOKEN22, ATA, bondingCurveOf, ataOf, creatorVaultOf, ammVaultOf, RENT0, accounts, tokenAmount, tokenOwner, balance,
  q, ready, dbReady, log, clean, BANNED, isAddr, isSig, origin, TREASURY, CUT_BPS, OPTED_OUT,
};
