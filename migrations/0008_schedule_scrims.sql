-- 段階 5-1：予定表とスクリム（DB設計書 3-3・3-4）

CREATE TABLE schedule_slots (
  id             TEXT PRIMARY KEY,
  tournament_id  TEXT NOT NULL REFERENCES tournaments(id),
  date           TEXT NOT NULL,      -- 日本時間の YYYY-MM-DD
  std_start      TEXT NOT NULL,      -- 標準の時間帯（HH:MM）
  std_end        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (tournament_id, date)
);

-- 管理者も入力するので users にひもづける（チーム・立場は表示するときに tournament_members から引く）
CREATE TABLE availabilities (
  id                      TEXT PRIMARY KEY,
  slot_id                 TEXT NOT NULL REFERENCES schedule_slots(id) ON DELETE CASCADE,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                  TEXT NOT NULL CHECK (status IN ('o','t','x')),
  start_time              TEXT,
  end_time                TEXT,
  changed_after_deadline  INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (slot_id, user_id)
);

CREATE TABLE scrims (
  id                 TEXT PRIMARY KEY,
  tournament_id      TEXT NOT NULL REFERENCES tournaments(id),
  requester_team_id  TEXT NOT NULL REFERENCES teams(id),
  opponent_team_id   TEXT NOT NULL REFERENCES teams(id),
  format             TEXT NOT NULL CHECK (format IN ('BO1','BO3','BO5')),
  status             TEXT NOT NULL CHECK (status IN ('requested','negotiating','confirmed','done','cancelled')),
  starts_at          TEXT,
  ends_at            TEXT,
  cancel_reason      TEXT,
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_scrims_tournament ON scrims(tournament_id, status);

CREATE TABLE scrim_candidates (
  id                   TEXT PRIMARY KEY,
  scrim_id             TEXT NOT NULL REFERENCES scrims(id) ON DELETE CASCADE,
  starts_at            TEXT NOT NULL,
  ends_at              TEXT NOT NULL,
  proposed_by_team_id  TEXT NOT NULL REFERENCES teams(id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE scrim_logs (
  id             TEXT PRIMARY KEY,
  scrim_id       TEXT NOT NULL REFERENCES scrims(id) ON DELETE CASCADE,
  action         TEXT NOT NULL CHECK (action IN ('requested','proposed','confirmed','done','cancelled')),
  actor_user_id  TEXT NOT NULL,
  note           TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE scrim_participants (
  scrim_id    TEXT NOT NULL REFERENCES scrims(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id     TEXT NOT NULL REFERENCES teams(id),
  via         TEXT NOT NULL CHECK (via IN ('team','fill')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (scrim_id, user_id)
);
