const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 銘柄名マスタ（J-Quants APIを呼ばずにここから返す）
const STOCK_NAMES = {
  "7203": "トヨタ自動車",
  "6758": "ソニーグループ",
  "9984": "ソフトバンクグループ",
  "6861": "キーエンス",
  "8306": "三菱UFJフィナンシャル・グループ",
  "9432": "NTT",
  "6367": "ダイキン工業",
  "8058": "三菱商事",
  "9983": "ファーストリテイリング",
  "6954": "ファナック",
  "4063": "信越化学工業",
  "8035": "東京エレクトロン",
  "7267": "本田技研工業",
  "4502": "武田薬品工業",
  "8316": "三井住友フィナンシャルグループ",
  "9020": "東日本旅客鉄道",
  "8801": "三井不動産",
  "9101": "日本郵船",
  "6501": "日立製作所",
  "4661": "オリエンタルランド",
};

// 期間別の日数マップ
const PERIOD_DAYS = { '1w': 7, '1m': 30, '3m': 90, '1y': 365 };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-cache');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { code, period = '1m' } = req.query;

  if (!code) {
    return res.status(400).json({ error: '銘柄コードを入力してください' });
  }

  const normalizedCode = code.replace(/\D/g, '').padStart(4, '0').substring(0, 4);
  if (normalizedCode.length !== 4 || normalizedCode === '0000') {
    return res.status(400).json({ error: '正しい銘柄コード（4桁）を入力してください' });
  }

  // 取得期間の計算（Supabaseに入っているデータの範囲内で）
  const periodDays = PERIOD_DAYS[period] || 30;
  const fmt = d => d.toISOString().split('T')[0];
  const to = new Date();
  to.setDate(to.getDate() - 84);         // 12週前
  const from = new Date(to);
  from.setDate(from.getDate() - periodDays);

  try {
    // SupabaseからSELECTするだけ（J-Quants APIは呼ばない）
    const { data, error } = await supabase
      .from('stock_prices')
      .select('code, date, open, high, low, close, volume')
      .eq('code', normalizedCode)
      .gte('date', fmt(from))
      .lte('date', fmt(to))
      .order('date', { ascending: true });

    if (error) throw new Error(error.message);

    const name = STOCK_NAMES[normalizedCode] || null;
    return res.status(200).json({ quotes: data || [], name });

  } catch (err) {
    console.error('stock API error:', err);
    return res.status(500).json({ error: err.message || 'サーバーエラーが発生しました' });
  }
};
