// GET /m/<id>  (→ /api/meta?id=)   the metadata JSON a coin's on-chain uri points at (when IPFS wasn't used)
// GET /i/<id>  (→ /api/meta?img=)  its picture
const L = require('./_lib');
module.exports = async (req, res) => { try { await handle(req, res); } catch (e) { if (!res.headersSent) L.send(res, 503, { error: 'records offline' }); } };
async function handle(req, res) {
  const qy = L.query(req);
  if (!L.dbReady()) return L.send(res, 404, { error: 'not found' });
  await L.ready();
  if (qy.img) {
    const id = String(qy.img).replace(/\.\w+$/, '');
    const r = /^[A-Za-z0-9_-]{6,20}$/.test(id) ? await L.q('SELECT img, state FROM fu_coins WHERE id=$1 AND img IS NOT NULL', [id]).catch(() => []) : [];
    if (!r.length) { res.statusCode = 404; res.setHeader('Cache-Control', 'public, max-age=30'); return res.end(); }
    res.statusCode = 200; res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=31536000, immutable');
    return res.end(Buffer.from(r[0].img));
  }
  const id = String(qy.id || '').replace(/\.json$/, '');
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return L.send(res, 404, { error: 'not found' });
  const r = await L.q('SELECT id, mint, name, symbol, description, twitter, website FROM fu_coins WHERE id=$1', [id]).catch(() => []);
  if (!r.length) return L.send(res, 404, { error: 'not found' }, 'public, max-age=30');
  const k = r[0], site = L.origin(req), page = site + '/c/' + k.mint;
  L.send(res, 200, { name: k.name, symbol: k.symbol, description: k.description, image: site + '/i/' + k.id, showName: true, createdOn: site,
    twitter: k.twitter || undefined, website: k.website || page, external_url: page }, 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800');
}
