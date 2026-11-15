-- 段階 5-3：チームページ（DB設計書 3-8）
CREATE TABLE team_pages (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id),
  title       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  deleted_at  TEXT,                 -- 30 日後に物理削除（それまでは元に戻せる）
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_team_pages ON team_pages(team_id);

CREATE TABLE team_posts (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL REFERENCES team_pages(id) ON DELETE CASCADE,
  author_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  image_ids       TEXT,             -- 画像の ID の JSON 配列（4 枚まで）
  deleted_at      TEXT,             -- 10 日後に物理削除
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_team_posts ON team_posts(page_id, created_at);

CREATE TABLE post_reactions (
  post_id     TEXT NOT NULL REFERENCES team_posts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id, emoji)
);
