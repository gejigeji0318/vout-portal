import type { Env } from '../env';
import { sendMessage } from './discord';

export const NOTIFICATION_KINDS = [
  'default', 'announcement', 'selection_result', 'scrim', 'fill', 'fill_ob', 'transfer', 'schedule_deadline', 'approval', 'inquiry', 'lanes_sync',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** 設定に保存する送り先。チャンネルの ID と名前だけで、秘密の値は含まない */
export interface NotifyTarget { channelId: string; channelName: string; categoryName: string | null; kind: 'text' | 'announcement' }

export async function getTarget(db: D1Database, kind: NotificationKind): Promise<NotifyTarget | null> {
  const row =
    (await db.prepare('SELECT value FROM settings WHERE key = ?').bind(`notification.${kind}`).first<{ value: string }>()) ??
    (await db.prepare('SELECT value FROM settings WHERE key = ?').bind('notification.default').first<{ value: string }>());
  return row ? (JSON.parse(row.value) as NotifyTarget) : null;
}

/** Discord への通知。送り先は通知の種類ごとの設定、無ければ大会全体（default） */
export async function notify(env: Env, kind: NotificationKind, content: string, mentionUserIds: string[] = []): Promise<{ ok: boolean; reason?: string }> {
  const target = await getTarget(env.DB, kind);
  if (!target) return { ok: false, reason: '送り先が設定されていません' };
  return sendMessage(env, target.channelId, content, mentionUserIds);
}
