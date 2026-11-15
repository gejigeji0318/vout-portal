-- 段階 6-2：二人承認と大会終了（DB設計書 3-9）
CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('admin_grant','admin_revoke','tournament_end')),
  payload       TEXT NOT NULL,          -- 対象（利用者 ID・付ける種別・大会 ID など）の JSON
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  requested_by  TEXT NOT NULL,
  decided_by    TEXT,
  decided_at    TEXT,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_approvals_status ON approvals(status);

-- 大会終了後 10 日以内の復元で、元の段階に戻すため
ALTER TABLE tournaments ADD COLUMN phase_before_end TEXT;
