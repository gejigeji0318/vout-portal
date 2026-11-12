/**
 * 入力欄の下にすぐ理由を出すための確認（サーバー側でも同じ内容を必ず確認する。こちらは分かりやすさのため）
 */
export const STREAM_HOSTS = ['twitch.tv', 'youtube.com', 'youtu.be', 'twitcasting.tv', 'openrec.tv', 'kick.com', 'nicovideo.jp'];

function urlError(v: string, hosts: string[] | null, siteName: string): string | null {
  const s = v.trim();
  if (!s) return null;
  let u: URL;
  try { u = new URL(s); } catch { return 'URL の形式になっていません（https:// から入力してください）'; }
  if (u.protocol !== 'https:') return 'https:// で始まる URL を入力してください';
  if (hosts && !hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return `${siteName}の URL を入力してください`;
  return null;
}

export const streamUrlError = (v: string) => urlError(v, STREAM_HOSTS, 'Twitch・YouTube・ツイキャス・OPENREC・Kick・ニコニコ生放送');
export const opggUrlError = (v: string) => urlError(v, ['op.gg'], 'OP.GG ');
export const xAccountError = (v: string) => {
  const s = v.trim().replace(/^@/, '');
  if (!s) return null;
  return /^[A-Za-z0-9_]{1,15}$/.test(s) ? null : '英数字と _ の 15 文字以内で入力してください（@ は不要です）';
};
