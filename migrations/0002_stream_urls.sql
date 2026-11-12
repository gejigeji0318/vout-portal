-- 配信 URL を複数（最大 3 件）持てるようにする
-- 1 件だけの列（stream_url）から、JSON 配列の列（stream_urls）に移す
ALTER TABLE users ADD COLUMN stream_urls TEXT;
UPDATE users SET stream_urls = json_array(stream_url) WHERE stream_url IS NOT NULL;
ALTER TABLE users DROP COLUMN stream_url;
