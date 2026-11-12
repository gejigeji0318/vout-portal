-- 段階 3：応募・選考（DB設計書 3-5）

CREATE TABLE recruitments (
  id             TEXT PRIMARY KEY,
  tournament_id  TEXT NOT NULL UNIQUE REFERENCES tournaments(id),
  body           TEXT NOT NULL,
  kinds          TEXT NOT NULL,          -- 募集する区分（player・coach・staff の JSON 配列）
  opens_at       TEXT NOT NULL,
  closes_at      TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE recruitment_checks (
  id              TEXT PRIMARY KEY,
  recruitment_id  TEXT NOT NULL REFERENCES recruitments(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  sort_order      INTEGER NOT NULL,
  fixed           INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,                  -- 同意済みの応募があるので、消さずに隠す
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- 選考の結果はこのテーブルに持たない（発表前の判定を本人に返さないため）
CREATE TABLE applications (
  id               TEXT PRIMARY KEY,
  recruitment_id   TEXT NOT NULL REFERENCES recruitments(id),
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('player','coach','staff')),
  opgg_url         TEXT NOT NULL,
  rank             TEXT,
  main_lane        TEXT CHECK (main_lane IN ('TOP','JG','MID','BOT','SUP','ALL')),
  second_lane      TEXT CHECK (second_lane IN ('TOP','JG','MID','BOT','SUP','ALL')),
  x_account        TEXT,
  stream_urls      TEXT,
  photo_image_id   TEXT NOT NULL REFERENCES images(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (recruitment_id, user_id)
);

CREATE TABLE application_checks (
  application_id  TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  check_id        TEXT NOT NULL REFERENCES recruitment_checks(id),
  agreed_at       TEXT NOT NULL,
  PRIMARY KEY (application_id, check_id)
);

-- 審査（管理者以外には返さない）。担当を割り当てた時点で行を作る
CREATE TABLE reviews (
  id                TEXT PRIMARY KEY,
  application_id    TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  reviewer_user_id  TEXT NOT NULL REFERENCES users(id),
  assigned_by       TEXT NOT NULL,
  grade             TEXT CHECK (grade IN ('A','B','C','D','E')),
  comment           TEXT,
  submitted_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (application_id, reviewer_user_id)
);

-- 仮決定表（入っている応募だけが行を持つ。管理者以外には返さない）
CREATE TABLE provisional_decisions (
  application_id  TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  member_type     TEXT NOT NULL CHECK (member_type IN ('player','coach','staff')),
  draft_role      TEXT CHECK (draft_role IN ('TOP','JG','MID','BOT','SUP')),
  team_id         TEXT REFERENCES teams(id),
  updated_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- 不採用の記録（応募の中身は消し、これだけ残す）
CREATE TABLE rejection_records (
  id             TEXT PRIMARY KEY,
  tournament_id  TEXT NOT NULL REFERENCES tournaments(id),
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decided_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (tournament_id, user_id)
);
