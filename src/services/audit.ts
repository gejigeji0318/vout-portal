import { ulid } from '../lib/id';
import { nowIso } from '../lib/time';

/**
 * 操作ログ（S-7）。追記のみ。detail に名前・Discord ID・秘密情報は入れない（DB設計書 audit_logs）
 */
export async function writeAudit(
  db: D1Database,
  actorUserId: string | null,
  action: string,
  target?: { type: string; id: string },
  detail?: Record<string, unknown>,
): Promise<void> {
  const t = nowIso();
  await db
    .prepare('INSERT INTO audit_logs (id, at, actor_user_id, action, target_type, target_id, detail, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(ulid(), t, actorUserId, action, target?.type ?? null, target?.id ?? null, detail ? JSON.stringify(detail) : null, t, t)
    .run();
}
