const { createClient } = require('@supabase/supabase-js');

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// In-memory token cache (reused across warm invocations)
let cachedIdToken  = null;
let idTokenExpiry  = 0;

// ── J-Quants authentication ────────────────────────────────────
async function getIdToken() {
  if (cachedIdToken && Date.now() < idTokenExpiry) return cachedIdToken;

  // Step 1: exchange email/password → refreshToken
  const authRes = await fetch('https://api.jquants.com/v1/token/auth_user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mailaddress: process.env.JQUANTS_EMAIL,
      password:    process.env.JQUANTS_PASSWORD
    })
  });

  if (!authRes.ok) {
    const body = await authRes.text();
    throw new Error(`J-Quants認証失敗 (${authRes.status}): ${body}`);
  }

  const { refreshToken } = await authRes.json();
  if (!refreshToken) throw new Error('refreshToken が取得できませんでした');

  // Step 2: exchange refreshToken → idToken
  const idRes = await fetch(
    `https://api.jquants.com/v1/token/auth_refresh?refreshToken=${encodeURIComponent(refreshToken)}`,
    { method: 'POST' }
  );

  if (!idRes.ok) {
    const body = await idRes.text();
    throw new Error(`IDトークン取得失敗 (${idRes.status}): ${body}`);
  }

  const { idToken } = await idRes.json();
  if (!idToken) throw new Error('idToken が取得できませんでした');

  cachedIdToken = idToken;
  idTokenExpiry = Date.now() + 22 * 60 * 60 * 1000; // 22 hours (token valid 24h)

  return idToken;
}

// ── J-Quants price fetch ──────────────────────────────────────
async function fetchJQuants(code, from, to) {
  const token = await getIdToken();
  const url   = `https://api.jquants.com/v1/prices/daily_quotes?code=${code}&from=${from}&to=${to}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`株価取得失敗 (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.daily_quotes || [];
}

// ── Date helpers ──────────────────────────────────────────────
function getPeriodDates(period) {
  const daysMap = { '1w': 10, '1m': 35, '3m': 95, '1y': 370 };
  const days    = daysMap[period] || 35;

  const to   = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);

  const fmt = d => d.toISOString().split('T')[0];
  return { from: fmt(from), to: fmt(to) };
}

function isoToday() {
  return new Date().toISOString().split('T')[0];
}

function isoYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// ── Supabase cache helpers ────────────────────────────────────
async function queryCache(code, from, to) {
  const { data, error } = await supabase
    .from('stock_prices')
    .select('code, date, open, high, low, close, volume')
    .eq('code', code)
    .gte('date', from)
    .lte('date', to)
    .order('date', { ascending: true });

  if (error) console.error('Supabase query error:', error);
  return data || [];
}

async function upsertCache(rows) {
  const { error } = await supabase
    .from('stock_prices')
    .upsert(rows, { onConflict: 'code,date' });

  if (error) console.error('Supabase upsert error:', error);
}

// ── Transform J-Quants response rows ─────────────────────────
function transformRows(rawQuotes, code) {
  return rawQuotes.map(q => ({
    code:   code,
    date:   q.Date,
    open:   q.Open,
    high:   q.High,
    low:    q.Low,
    close:  q.Close,
    volume: q.Volume
  }));
}

// ── Main handler ──────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-cache');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { code, period = '1m' } = req.query;

  if (!code) {
    return res.status(400).json({ error: '銘柄コードを入力してください' });
  }

  // Normalize to 4-digit numeric code
  const normalizedCode = code.replace(/\D/g, '').padStart(4, '0').substring(0, 4);
  if (normalizedCode.length !== 4 || normalizedCode === '0000') {
    return res.status(400).json({ error: '正しい銘柄コード（4桁）を入力してください' });
  }

  const { from, to } = getPeriodDates(period);

  try {
    // 1. Check Supabase cache
    let quotes = await queryCache(normalizedCode, from, to);

    // 2. Determine if cache is fresh (contains today or yesterday data)
    const today     = isoToday();
    const yesterday = isoYesterday();
    const hasRecent = quotes.some(r => r.date >= yesterday);

    if (!hasRecent) {
      // 3. Fetch from J-Quants
      const fetchFrom = quotes.length > 0 ? yesterday : from;
      const rawQuotes = await fetchJQuants(normalizedCode, fetchFrom, to);

      if (rawQuotes.length > 0) {
        const rows = transformRows(rawQuotes, normalizedCode);

        // 4. Save to Supabase
        await upsertCache(rows);

        // 5. Re-query to get full ordered data for the requested period
        quotes = await queryCache(normalizedCode, from, to);

        // Fallback: if re-query returns nothing, use freshly fetched rows
        if (!quotes.length) {
          quotes = rows.filter(r => r.date >= from && r.date <= to);
        }
      }
    }

    return res.status(200).json({ quotes });

  } catch (err) {
    console.error('stock API error:', err);
    return res.status(500).json({ error: err.message || 'サーバーエラーが発生しました' });
  }
};
