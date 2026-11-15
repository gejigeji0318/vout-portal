-- 段階 5-2：人員補充（DB設計書 3-4）

CREATE TABLE fill_requests (
  id             TEXT PRIMARY KEY,
  tournament_id  TEXT NOT NULL REFERENCES tournaments(id),
  scrim_id       TEXT NOT NULL REFERENCES scrims(id) ON DELETE CASCADE,
  team_id        TEXT NOT NULL REFERENCES teams(id),        -- 補充を募集するチーム
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','cancelled')),
  ob_post_at     TEXT,                                      -- OB への募集を出す時刻（自動）
  ob_posted_at   TEXT,                                      -- OB に募集を出した時刻（出したら OB にも見える）
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_fill_requests ON fill_requests(tournament_id, status);

-- 1 人分ごとに 1 行
CREATE TABLE fill_slots (
  id                     TEXT PRIMARY KEY,
  request_id             TEXT NOT NULL REFERENCES fill_requests(id) ON DELETE CASCADE,
  lane                   TEXT NOT NULL CHECK (lane IN ('TOP','JG','MID','BOT','SUP','ANY')),
  filled_application_id  TEXT,
  filled_at              TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- 応募と声かけ。声かけ（invited）だけでは決まらない：本人が応募（applied）し、コーチか管理者が承認（approved）して決まる
CREATE TABLE fill_applications (
  id              TEXT PRIMARY KEY,
  slot_id         TEXT NOT NULL REFERENCES fill_slots(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  applicant_kind  TEXT NOT NULL CHECK (applicant_kind IN ('player','staff','admin','ob')),
  status          TEXT NOT NULL CHECK (status IN ('invited','applied','approved','declined','not_selected','withdrawn')),
  invited_by      TEXT,
  decided_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (slot_id, user_id)
);
CREATE INDEX idx_fill_applications_user ON fill_applications(user_id);
