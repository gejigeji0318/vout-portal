-- 運営が応募内容を修正した日時（本人の応募状況に「運営が修正しました」と表示するため）
ALTER TABLE applications ADD COLUMN staff_edited_at TEXT;
