import type { Env } from '../env';
import { HttpError } from '../lib/errors';

export const DISCORD_API = 'https://discord.com/api/v10';

// Discord のチャンネルの種類（通知に使えるのはテキストとアナウンスだけ）
const TYPE_TEXT = 0;
const TYPE_CATEGORY = 4;
const TYPE_ANNOUNCEMENT = 5;

interface RawChannel { id: string; type: number; name: string; parent_id?: string | null; position?: number }

export interface NotifyChannel { id: string; name: string; kind: 'text' | 'announcement'; categoryId: string | null; categoryName: string | null }
export interface ChannelGroup { categoryId: string | null; categoryName: string | null; channels: NotifyChannel[] }

async function botFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) throw new HttpError(409, 'discord_not_configured', 'Discord の Bot が設定されていません');
  try {
    return await fetch(`${DISCORD_API}${path}`, {
      ...init,
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    // Discord に接続できない（障害・ネットワーク）ときは、分かる言葉で返す
    throw new HttpError(409, 'discord_unavailable', 'Discord に接続できませんでした。時間をおいてもう一度お試しください');
  }
}

/** 固定のサーバーのうち、通知に使えるチャンネル（テキスト・アナウンス）をカテゴリーごとにまとめて返す */
export async function listNotifyChannels(env: Env): Promise<NotifyChannel[]> {
  const res = await botFetch(env, `/guilds/${encodeURIComponent(env.DISCORD_GUILD_ID)}/channels`);
  if (!res.ok) throw new HttpError(409, 'discord_unavailable', 'Discord からチャンネルの一覧を取得できませんでした。Bot がサーバーに参加しているか確認してください');
  const raw = (await res.json()) as RawChannel[];
  const byPos = (a: RawChannel, b: RawChannel) => (a.position ?? 0) - (b.position ?? 0);
  const categories = new Map(raw.filter((c) => c.type === TYPE_CATEGORY).map((c) => [c.id, c]));
  return raw
    .filter((c) => c.type === TYPE_TEXT || c.type === TYPE_ANNOUNCEMENT)
    .sort((a, b) => {
      const ca = a.parent_id ? categories.get(a.parent_id) : undefined;
      const cb = b.parent_id ? categories.get(b.parent_id) : undefined;
      return (ca?.position ?? -1) - (cb?.position ?? -1) || byPos(a, b);
    })
    .map((c) => {
      const cat = c.parent_id ? categories.get(c.parent_id) : undefined;
      return { id: c.id, name: c.name, kind: c.type === TYPE_ANNOUNCEMENT ? 'announcement' : 'text', categoryId: cat?.id ?? null, categoryName: cat?.name ?? null };
    });
}

export function groupByCategory(channels: NotifyChannel[]): ChannelGroup[] {
  const groups = new Map<string, ChannelGroup>();
  for (const ch of channels) {
    const key = ch.categoryId ?? '';
    if (!groups.has(key)) groups.set(key, { categoryId: ch.categoryId, categoryName: ch.categoryName, channels: [] });
    groups.get(key)!.channels.push(ch);
  }
  return [...groups.values()];
}

/**
 * Bot でメッセージを送る。@everyone などのメンションは、指定した本人（mentionUserIds）以外すべて無効にする。
 * 送れなかった理由（権限不足など）を返す。
 */
export async function sendMessage(env: Env, channelId: string, content: string, mentionUserIds: string[] = []): Promise<{ ok: boolean; reason?: string }> {
  let res: Response;
  try {
    res = await botFetch(env, `/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [], users: mentionUserIds.slice(0, 20) } }),
    });
  } catch (e) {
    return { ok: false, reason: e instanceof HttpError ? e.message : 'Discord への送信に失敗しました' };
  }
  if (res.ok) return { ok: true };
  // Discord が返すエラー番号（https://discord.com/developers/docs/topics/opcodes-and-status-codes）
  const err = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
  console.warn(`discord send failed: status=${res.status} code=${err.code ?? '-'} message=${err.message ?? '-'}`);
  const code = err.code ? `（Discord のエラー番号 ${err.code}）` : `（HTTP ${res.status}）`;
  if (err.code === 50001) return { ok: false, reason: `Bot がこのチャンネルを見られません。チャンネルの権限で「チャンネルを見る」を許可してください${code}` };
  if (err.code === 50013) return { ok: false, reason: `Bot にこのチャンネルへの投稿権限がありません。チャンネルの権限で「メッセージを送信」を許可してください${code}` };
  if (res.status === 403) return { ok: false, reason: `Bot にこのチャンネルへの投稿権限がありません${code}` };
  if (res.status === 404) return { ok: false, reason: `チャンネルが見つかりません（削除された可能性があります）${code}` };
  if (res.status === 429) return { ok: false, reason: `送信が多すぎるため、Discord に一時的に止められました。少し待ってからお試しください${code}` };
  return { ok: false, reason: `Discord への送信に失敗しました${code}` };
}
