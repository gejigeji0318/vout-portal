-- 段階1：土台（DB設計書 3-1・3-2・3-9 の一部）
-- 日時はすべて UTC の ISO 8601 文字列。ID は ULID。

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  discord_user_id  TEXT NOT NULL UNIQUE,
  discord_name     TEXT NOT NULL,
  display_name     TEXT,
  admin_level      TEXT NOT NULL DEFAULT 'none' CHECK (admin_level IN ('none','sub','super')),
  icon_image_id    TEXT,
  bio              TEXT,
  stream_url       TEXT,
  x_account        TEXT,
  time_presets     TEXT,
  ob_verified_at   TEXT,
  last_login_at    TEXT NOT NULL,
  suspended_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,           -- セッション値の SHA-256（値そのものは保存しない）
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE oauth_states (
  id                 TEXT PRIMARY KEY,    -- state の SHA-256
  code_verifier_enc  TEXT NOT NULL,
  purpose            TEXT NOT NULL CHECK (purpose IN ('login','ob_verify')),
  expires_at         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE tournaments (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  phase              TEXT NOT NULL DEFAULT 'preparing'
                     CHECK (phase IN ('preparing','recruiting','selecting','drafting','scrim','main','ended')),
  period_start       TEXT NOT NULL,
  period_end         TEXT NOT NULL,
  team_count         INTEGER NOT NULL CHECK (team_count BETWEEN 2 AND 16),
  scrim_start        TEXT,
  scrim_end          TEXT,
  schedule_deadline  TEXT,
  announced_at       TEXT,
  ended_at           TEXT,
  deleted_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE teams (
  id                  TEXT PRIMARY KEY,
  tournament_id       TEXT NOT NULL REFERENCES tournaments(id),
  name                TEXT,
  intro_published_at  TEXT,
  deleted_at          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_teams_tournament ON teams(tournament_id);

CREATE TABLE tournament_members (
  id              TEXT PRIMARY KEY,
  tournament_id   TEXT NOT NULL REFERENCES tournaments(id),
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_type     TEXT NOT NULL CHECK (member_type IN ('player','coach','staff')),
  team_id         TEXT REFERENCES teams(id),
  draft_role      TEXT CHECK (draft_role IN ('TOP','JG','MID','BOT','SUP')),
  lane            TEXT CHECK (lane IN ('TOP','JG','MID','BOT','SUP')),
  publish_photo   INTEGER NOT NULL DEFAULT 0,
  publish_x       INTEGER NOT NULL DEFAULT 0,
  publish_stream  INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (tournament_id, user_id)
);
CREATE INDEX idx_members_team ON tournament_members(team_id);

CREATE TABLE events (
  id             TEXT PRIMARY KEY,
  tournament_id  TEXT NOT NULL REFERENCES tournaments(id),
  kind           TEXT NOT NULL CHECK (kind IN ('main','stream')),
  title          TEXT NOT NULL,
  starts_at      TEXT NOT NULL,
  ends_at        TEXT NOT NULL,
  url            TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE images (
  id             TEXT PRIMARY KEY,
  owner_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tournament_id  TEXT REFERENCES tournaments(id),
  purpose        TEXT NOT NULL CHECK (purpose IN ('promo','staff_icon','post','page')),
  r2_key         TEXT NOT NULL UNIQUE,
  content_type   TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  size_bytes     INTEGER NOT NULL CHECK (size_bytes <= 5242880),
  deleted_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE audit_logs (
  id             TEXT PRIMARY KEY,
  at             TEXT NOT NULL,
  actor_user_id  TEXT,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  detail         TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_audit_at ON audit_logs(at);
CREATE INDEX idx_audit_action ON audit_logs(action);
CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id);
