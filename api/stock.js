const { createClient } = require('@supabase/supabase-js');

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── J-Quants price fetch ──────────────────────────────────────
async function fetchJQuants(code, from, to) {
  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) throw new Error('JQUANTS_API_KEY が設定されていません');

  const url = `https://api.jquants.com/v2/equities/bars/daily?code=${code}&from=${from}&to=${to}`;

  const res = await fetch(url, {
    headers: { 'x-api-key': apiKey }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`株価取得失敗 (${res.status}): ${body}`);
  }

  const data = await res.json();
  // v2 レスポンスキーは bars、フォールバックで daily_quotes も確認
  return data.bars || data.daily_quotes || [];
}

// ── Date helpers ──────────────────────────────────────────────
// J-Quants Free プラン制限：直近12週間は取得不可
// to = 今日から91日前（13週前）、from = to から period 分遡る
function getPeriodDates(period) {
  const periodDaysMap = { '1w': 7, '1m': 30, '3m': 90, '1y': 365 };
  const periodDays    = periodDaysMap[period] || 30;

  const fmt = d => d.toISOString().split('T')[0];

  const to = new Date();
  to.setDate(to.getDate() - 91);       // 今日から13週前

  const from = new Date(to);
  from.setDate(from.getDate() - periodDays);

  return { from: fmt(from), to: fmt(to) };
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
    date:   q.date   ?? q.Date,
    open:   q.open   ?? q.Open,
    high:   q.high   ?? q.High,
    low:    q.low    ?? q.Low,
    close:  q.close  ?? q.Close,
    volume: q.volume ?? q.Volume
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

    // 2. キャッシュが to 日付付近まであるか確認（3日以内を許容）
    const toMinus3 = new Date(to);
    toMinus3.setDate(toMinus3.getDate() - 3);
    const hasRecent = quotes.some(r => r.date >= toMinus3.toISOString().split('T')[0]);

    if (!hasRecent) {
      // 3. Fetch from J-Quants
      const fetchFrom = quotes.length > 0 ? to : from;
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
