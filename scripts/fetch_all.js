// ============================================================
// fetch_all.js
// 日経225全銘柄の過去データを一括取得してSupabaseに保存する
// 【使い方】ローカルで1回だけ実行する。Vercelにはデプロイしない。
//
// 実行前準備:
//   1. プロジェクトルートに .env.local があること（VercelのEnvと同じ値）
//   2. npm install dotenv @supabase/supabase-js
//   3. nikkei225_stocks.js がプロジェクトルートにあること
//
// 実行コマンド:
//   node scripts/fetch_all.js
// ============================================================

require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const { NIKKEI225_STOCKS } = require('../nikkei225_stocks.js');

// ── Supabase クライアント ─────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── 設定 ─────────────────────────────────────────────────────
const SLEEP_MS        = 500;  // 銘柄間の待機時間（ms）APIレート制限対策
const BATCH_SIZE      = 50;    // Supabaseへの1回のupsert件数
const RETRY_MAX       = 3;     // 失敗時のリトライ回数
const RETRY_SLEEP_MS  = 30000;  // リトライ前の待機時間（ms）

// ── 取得期間の計算 ────────────────────────────────────────────
// J-Quants無料プラン：直近12週間は取得不可
// to   = 今日から13週前（91日前）
// from = toから約2年前（730日前）
function getDateRange() {
  const fmt = d => d.toISOString().split('T')[0];

  const to = new Date();
  to.setDate(to.getDate() - 84);       // 13週前

  const from = new Date(to);
  from.setDate(from.getDate() - 700);  // さらに2年前

  return { from: fmt(from), to: fmt(to) };
}

// ── ユーティリティ ────────────────────────────────────────────
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function formatDate(d) {
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

// ── J-Quants APIから株価取得 ──────────────────────────────────
async function fetchJQuants(code, from, to) {
  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) throw new Error('JQUANTS_API_KEY が設定されていません');

  const url = `https://api.jquants.com/v2/equities/bars/daily?code=${code}&from=${from}&to=${to}`;

  const res = await fetch(url, {
    headers: { 'x-api-key': apiKey }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`APIエラー (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.data || [];
}

// ── J-Quantsデータをsupabase用に変換 ─────────────────────────
function transformRows(rawQuotes, code) {
  return rawQuotes.map(q => ({
    code:   code,
    date:   q.Date,
    open:   q.AdjO,
    high:   q.AdjH,
    low:    q.AdjL,
    close:  q.AdjC,
    volume: q.AdjVo
  }));
}

// ── Supabaseにバッチupsert ────────────────────────────────────
async function upsertBatch(rows) {
  const { error } = await supabase
    .from('stock_prices')
    .upsert(rows, { onConflict: 'code,date' });

  if (error) throw new Error(`Supabase upsertエラー: ${error.message}`);
}

// ── 1銘柄分の処理（リトライ付き） ────────────────────────────
async function processTicker(code, name, from, to) {
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      const rawQuotes = await fetchJQuants(code, from, to);

      if (rawQuotes.length === 0) {
        return { code, name, count: 0, status: 'empty' };
      }

      const rows = transformRows(rawQuotes, code);

      // BATCH_SIZE件ずつ分割してupsert
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        await upsertBatch(rows.slice(i, i + BATCH_SIZE));
      }

      return { code, name, count: rows.length, status: 'ok' };

    } catch (err) {
      if (attempt < RETRY_MAX) {
        console.log(`  ⚠️  ${code} ${name} エラー（${attempt}回目）: ${err.message} → ${RETRY_SLEEP_MS/1000}秒後リトライ`);
        await sleep(RETRY_SLEEP_MS);
      } else {
        return { code, name, count: 0, status: 'error', error: err.message };
      }
    }
  }
}

// ── メイン処理 ────────────────────────────────────────────────
async function main() {
  console.log('============================================================');
  console.log('  日経225 一括取得スクリプト');
  console.log(`  実行開始: ${formatDate(new Date())}`);
  console.log('============================================================');

  // 環境変数チェック
  const required = ['SUPABASE_URL', 'SUPABASE_KEY', 'JQUANTS_API_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`❌ 環境変数が不足しています: ${missing.join(', ')}`);
    console.error('   .env.local を確認してください');
    process.exit(1);
  }

  const { from, to } = getDateRange();
  console.log(`\n📅 取得期間: ${from} 〜 ${to}`);
  console.log(`📊 対象銘柄: ${NIKKEI225_STOCKS.length}銘柄`);
  console.log(`⏱️  推定時間: 約${Math.ceil(NIKKEI225_STOCKS.length * SLEEP_MS / 60000)}分\n`);

  const results = { ok: [], empty: [], error: [] };
  const startTime = Date.now();

  for (let i = 0; i < NIKKEI225_STOCKS.length; i++) {
    const { code, name } = NIKKEI225_STOCKS[i];
    const progress = `[${String(i + 1).padStart(3)}/${NIKKEI225_STOCKS.length}]`;

    process.stdout.write(`${progress} ${code} ${name} ... `);

    const result = await processTicker(code, name, from, to);

    if (result.status === 'ok') {
      console.log(`✅ ${result.count}件`);
      results.ok.push(result);
    } else if (result.status === 'empty') {
      console.log(`⚪ データなし`);
      results.empty.push(result);
    } else {
      console.log(`❌ エラー: ${result.error}`);
      results.error.push(result);
    }

    // 最後の銘柄以外はスリープ
    if (i < NIKKEI225_STOCKS.length - 1) {
      await sleep(SLEEP_MS);
    }
  }

  // ── 結果サマリー ─────────────────────────────────────────────
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const totalRecords = results.ok.reduce((sum, r) => sum + r.count, 0);

  console.log('\n============================================================');
  console.log('  完了サマリー');
  console.log('============================================================');
  console.log(`  実行時間  : ${Math.floor(elapsed/60)}分${elapsed%60}秒`);
  console.log(`  成功      : ${results.ok.length}銘柄`);
  console.log(`  データなし: ${results.empty.length}銘柄`);
  console.log(`  エラー    : ${results.error.length}銘柄`);
  console.log(`  総レコード数: ${totalRecords.toLocaleString()}件`);

  if (results.error.length > 0) {
    console.log('\n❌ エラーになった銘柄:');
    results.error.forEach(r => {
      console.log(`   ${r.code} ${r.name}: ${r.error}`);
    });
    console.log('\n上記の銘柄は手動で再実行するか、後日再試行してください。');
  }

  if (results.empty.length > 0) {
    console.log('\n⚪ データなしの銘柄（J-Quantsに登録なしの可能性）:');
    results.empty.forEach(r => console.log(`   ${r.code} ${r.name}`));
  }

  console.log(`\n✅ 完了: ${formatDate(new Date())}`);
}

main().catch(err => {
  console.error('予期せぬエラーが発生しました:', err);
  process.exit(1);
});
