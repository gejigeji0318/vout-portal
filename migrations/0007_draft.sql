-- 段階 4：ドラフト（DB設計書 3-6）
-- 進行中の状態と公開前の指名は Durable Objects（それ自体が保存領域）が持つ。D1 には記録だけを残す

CREATE TABLE draft_sessions (
  id                     TEXT PRIMARY KEY,          -- 初期化するたびに作り直す
  tournament_id          TEXT NOT NULL REFERENCES tournaments(id),
  phase                  TEXT NOT NULL,
  round                  INTEGER NOT NULL DEFAULT 0,
  pick_seq               INTEGER NOT NULL DEFAULT 0,
  stream_key_hash        TEXT,                      -- 配信用 URL の鍵のハッシュ（鍵そのものは保存しない）
  stream_key_expires_at  TEXT,
  confirmed_at           TEXT,
  confirmed_by           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX idx_draft_sessions_tournament ON draft_sessions(tournament_id);

CREATE TABLE draft_results (
  session_id        TEXT NOT NULL REFERENCES draft_sessions(id) ON DELETE CASCADE,
  team_id           TEXT NOT NULL REFERENCES teams(id),
  round             INTEGER NOT NULL,
  player_member_id  TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (session_id, team_id, round)
);
