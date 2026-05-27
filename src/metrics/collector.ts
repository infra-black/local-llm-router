import Database from 'better-sqlite3'

const db = new Database(process.env.LLR_DB || './metrics.db')
db.exec(`
  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    backend TEXT NOT NULL,
    latency_ms INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    fallback_for TEXT,
    hop INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_metrics_backend ON metrics(backend);
  CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts DESC);
`)

try { db.exec('ALTER TABLE metrics ADD COLUMN hop INTEGER') } catch (_) {}

const insert = db.prepare(
  'INSERT INTO metrics (backend, latency_ms, ok, error, fallback_for, hop) VALUES (?, ?, ?, ?, ?, ?)',
)

export interface MetricEvent {
  backend: string
  latency: number
  ok: boolean
  error?: string
  fallbackFor?: string
  hop?: number
}

export function record(event: MetricEvent) {
  insert.run(
    event.backend,
    event.latency,
    event.ok ? 1 : 0,
    event.error || null,
    event.fallbackFor || null,
    event.hop ?? 0,
  )
}

export function summary(hours = 24) {
  const since = Date.now() - hours * 3600 * 1000
  return db
    .prepare(
      `SELECT backend, COUNT(*) AS calls, AVG(latency_ms) AS avg_latency,
              SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS successes
       FROM metrics WHERE ts >= ? GROUP BY backend ORDER BY calls DESC`,
    )
    .all(since)
}
