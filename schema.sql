-- Supabase で実行してください
-- stock_prices テーブルを作成

CREATE TABLE IF NOT EXISTS stock_prices (
  id         BIGSERIAL PRIMARY KEY,
  code       VARCHAR(5)     NOT NULL,
  date       DATE           NOT NULL,
  open       NUMERIC(12, 2),
  high       NUMERIC(12, 2),
  low        NUMERIC(12, 2),
  close      NUMERIC(12, 2),
  volume     BIGINT,
  created_at TIMESTAMPTZ    DEFAULT NOW(),
  CONSTRAINT stock_prices_code_date_key UNIQUE (code, date)
);

-- 検索高速化インデックス
CREATE INDEX IF NOT EXISTS idx_stock_prices_code_date
  ON stock_prices (code, date DESC);

-- RLS（Row Level Security）を無効化 ※ Vercel からのアクセスに service_role key を使う場合
-- ALTER TABLE stock_prices DISABLE ROW LEVEL SECURITY;

-- または anon key を使う場合は以下のポリシーを追加
-- ALTER TABLE stock_prices ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "allow_read" ON stock_prices FOR SELECT USING (true);
-- CREATE POLICY "allow_insert" ON stock_prices FOR INSERT WITH CHECK (true);
-- CREATE POLICY "allow_upsert" ON stock_prices FOR UPDATE USING (true);
