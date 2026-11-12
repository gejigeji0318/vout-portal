export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  DRAFT: DurableObjectNamespace<import('./draft/room').DraftRoom>;
  ENVIRONMENT: 'development' | 'test' | 'production';
  APP_ORIGIN: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  /** 通知用 Bot のトークン（シークレット） */
  DISCORD_BOT_TOKEN: string;
  /** 通知を送る Discord サーバーの ID（固定の 1 つ） */
  DISCORD_GUILD_ID: string;
  ENCRYPTION_KEY: string;
  SIGNING_KEY: string;
  /** 適性レーンのデータ（既存の championLane が GitHub Pages で公開している data.json） */
  LANES_DATA_URL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}

export type AdminLevel = 'none' | 'sub' | 'super';
export type MemberType = 'player' | 'coach' | 'staff';

export interface CurrentUser {
  id: string;
  discordName: string;
  displayName: string | null;
  adminLevel: AdminLevel;
  sessionId: string;
}

export type AppVars = { user: CurrentUser | null };
export type AppEnv = { Bindings: Env; Variables: AppVars };
