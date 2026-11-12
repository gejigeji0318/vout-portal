-- 適性レーンは、検査済みの 1 日分のデータを settings（lanes.snapshot）に 1 件で持つ。
-- レーンごとのピック率まで必要になったため、専用テーブルはやめる（まだデータは入っていない）
DROP TABLE lane_champions;
