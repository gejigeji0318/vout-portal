-- 段階 2：公開まわり（DB設計書 3-7・3-8・3-9 の一部）

-- 案内ページの本文（はじめに・大会概要・ルールブック・プライバシーポリシー）。種類ごとに一番新しい版が公開中
CREATE TABLE page_versions (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('about','overview','rules','privacy')),
  tournament_id  TEXT REFERENCES tournaments(id),
  version        INTEGER NOT NULL,
  body           TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_page_versions ON page_versions(kind, COALESCE(tournament_id, ''), version);

CREATE TABLE announcements (
  id             TEXT PRIMARY KEY,
  tournament_id  TEXT REFERENCES tournaments(id),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  category       TEXT NOT NULL CHECK (category IN ('general','schedule','rules','scrim','stream')),
  visibility     TEXT NOT NULL CHECK (visibility IN ('public','logged_in','targeted')),
  important      INTEGER NOT NULL DEFAULT 0,
  published_at   TEXT,              -- 空なら下書き。未来なら予約公開
  notified_at    TEXT,              -- 公開時の Discord 通知を送った日時（二重送信を防ぐ）
  created_by     TEXT NOT NULL,
  deleted_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_announcements_published ON announcements(published_at);

CREATE TABLE announcement_targets (
  id               TEXT PRIMARY KEY,
  announcement_id  TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  member_type      TEXT CHECK (member_type IN ('player','coach','staff')),
  team_id          TEXT REFERENCES teams(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_targets_announcement ON announcement_targets(announcement_id);

CREATE TABLE announcement_reads (
  announcement_id  TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at          TEXT NOT NULL,
  PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE inquiries (
  id                TEXT PRIMARY KEY,
  number            INTEGER NOT NULL UNIQUE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done')),
  assignee_user_id  TEXT,
  deleted_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_inquiries_user ON inquiries(user_id);

CREATE TABLE inquiry_messages (
  id              TEXT PRIMARY KEY,
  inquiry_id      TEXT NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
  sender_user_id  TEXT NOT NULL,
  from_staff      INTEGER NOT NULL DEFAULT 0,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_inquiry_messages ON inquiry_messages(inquiry_id);

CREATE TABLE lane_champions (
  champion_key  TEXT PRIMARY KEY,
  name_ja       TEXT NOT NULL,
  lane          TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
