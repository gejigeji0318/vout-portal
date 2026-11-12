export const MEMBER_TYPE: Record<string, string> = { player: '選手', coach: 'コーチ', staff: '補助スタッフ' };
export const ADMIN_LEVEL: Record<string, string> = { super: '全体管理者', sub: '補助管理者' };
export const PHASE: Record<string, string> = {
  preparing: '準備中', recruiting: '募集中', selecting: '選考中', drafting: 'ドラフト', scrim: 'スクリム期間', main: '本番', ended: '終了',
};
export const NOTIFICATION_KIND: Record<string, string> = {
  default: '大会全体（指定のない通知の送り先）', announcement: 'お知らせの公開', selection_result: '選考結果の発表', scrim: 'スクリム',
  fill: '人員補充', fill_ob: 'OB への補充募集', transfer: 'チーム移動（移籍）', schedule_deadline: '予定表の入力締切',
  approval: '二人承認の依頼', inquiry: '問い合わせの受付', lanes_sync: '適性レーンの取り込み',
};
export const AUDIT_ACTION: Record<string, string> = {
  login: 'ログイン', logout_all: '全端末からログアウト', tournament_create: '大会の作成', tournament_update: '大会設定の変更',
  team_rename: 'チーム名の変更', event_create: '日程の追加', event_update: '日程の変更', event_delete: '日程の削除',
  membership_change: '利用者タイプ・チームの変更', transfer: 'チーム移動（移籍）', user_suspend: '利用停止', user_unsuspend: '利用停止の解除',
  notification_setting_update: '通知の送り先の変更', notification_setting_delete: '通知の送り先の削除',
  page_update: '案内ページの編集', official_links_update: '公式リンクの変更', announcement_create: 'お知らせの作成', announcement_update: 'お知らせの変更',
  announcement_delete: 'お知らせの削除', announcement_publish: 'お知らせの公開', announcement_remind: '重要なお知らせの再通知', lanes_sync: '適性レーンの取り込み', lanes_visibility_update: '適性レーンの公開範囲の変更',
  inquiry_reply: '問い合わせへの返信', inquiry_update: '問い合わせの状態の変更',
};
export const LANES = ['TOP', 'JG', 'MID', 'BOT', 'SUP'];

const fmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDate = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' });
export const showDateTime = (iso: string | null | undefined) => (iso ? fmt.format(new Date(iso)) : '—');
export const showDate = (iso: string | null | undefined) => (iso ? fmtDate.format(new Date(iso)) : '—');

/** 入力欄（日本時間）⇔ 保存（UTC の ISO） */
export const toInputDate = (iso: string | null | undefined) => (iso ? new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10) : '');
export const toInputDateTime = (iso: string | null | undefined) => (iso ? new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 16) : '');
export const fromInputDate = (v: string) => (v ? new Date(`${v}T00:00:00+09:00`).toISOString() : null);
export const fromInputDateTime = (v: string) => (v ? new Date(`${v}:00+09:00`).toISOString() : null);

export const teamLabel = (teams: { id: string; name: string | null }[], id: string | null | undefined) => {
  if (!id) return '—';
  const i = teams.findIndex((t) => t.id === id);
  if (i < 0) return '—';
  return teams[i]!.name ?? `チーム ${i + 1}`;
};

export const CATEGORY: Record<string, string> = { general: '全般', schedule: '日程', rules: 'ルール', scrim: 'スクリム', stream: '配信' };
export const VISIBILITY: Record<string, string> = { public: '誰でも', logged_in: 'ログインした人', targeted: '対象者のみ' };
