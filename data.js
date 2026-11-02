// Vercel serverless function. Needs env vars:
//   MASTER_PASSWORD  (you choose it)
//   KV_REST_API_URL + KV_REST_API_TOKEN  (added automatically when you connect Upstash Redis in Vercel)
const U = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const T = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmds) {
  const r = await fetch(U + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + T },
    body: JSON.stringify(cmds),
  });
  return (await r.json()).map(o => o.result);
}

const lagosToday = () => new Date(Date.now() + 36e5).toISOString().slice(0, 10);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const [flat, ticks] = await redis([['HGETALL', 'names'], ['HKEYS', 'ticks']]);
      const names = {};
      for (let i = 0; i < flat.length; i += 2) names[flat[i]] = flat[i + 1];
      return res.json({ names, ticks });
    }
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    if (b.action === 'add') {
      const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 30);
      if (name.length < 2) return res.status(400).json({ error: 'Enter a valid name' });
      const [ok] = await redis([['HSETNX', 'names', name.toLowerCase(), name]]);
      if (!ok) return res.status(409).json({ error: 'That name is already on the list' });
      return res.json({ ok: true });
    }
    // everything below is master-only
    if (!process.env.MASTER_PASSWORD || b.pw !== process.env.MASTER_PASSWORD)
      return res.status(401).json({ error: 'Wrong master password' });
    if (b.action === 'login') return res.json({ ok: true });
    if (b.action === 'tick') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || b.date > lagosToday())
        return res.status(400).json({ error: 'Cannot tick a future day' });
      await redis([[b.on ? 'HSET' : 'HDEL', 'ticks', b.date + '|' + b.id, ...(b.on ? [1] : [])]]);
      return res.json({ ok: true });
    }
    if (b.action === 'remove') {
      const [keys] = await redis([['HKEYS', 'ticks']]);
      const mine = keys.filter(k => k.endsWith('|' + b.id));
      const cmds = [['HDEL', 'names', b.id]];
      if (mine.length) cmds.push(['HDEL', 'ticks', ...mine]);
      await redis(cmds);
      return res.json({ ok: true });
    }
    res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
};
