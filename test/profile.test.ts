import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { json, loginAs, makeUser, req } from './helpers';

describe('マイページ：表示名', () => {
  it('初期値は Discord の名前。設定するとその名前になり、空にすると戻る', async () => {
    const id = await makeUser({ name: 'discordname' });
    const a = await loginAs(id);
    expect((await json(await req('GET', '/api/me', { auth: a }))).user.displayName).toBe('discordname');
    expect((await req('PATCH', '/api/me', { auth: a, body: { displayName: 'ミッド太郎' } })).status).toBe(200);
    expect((await json(await req('GET', '/api/me', { auth: a }))).user.displayName).toBe('ミッド太郎');
    expect((await req('PATCH', '/api/me', { auth: a, body: { displayName: null } })).status).toBe(200);
    expect((await json(await req('GET', '/api/me', { auth: a }))).user.displayName).toBe('discordname');
  });

  it('他の人と同じ名前（全角・大文字の違いを含む）は使えない', async () => {
    await makeUser({ name: 'Takeshi' });
    const a = await loginAs(await makeUser());
    const res = await req('PATCH', '/api/me', { auth: a, body: { displayName: 'ｔａｋｅｓｈｉ' } });
    expect(res.status).toBe(409);
  });

  it('運営と紛らわしい名前は使えない', async () => {
    const a = await loginAs(await makeUser());
    expect((await req('PATCH', '/api/me', { auth: a, body: { displayName: '運営スタッフ' } })).status).toBe(422);
  });
});

describe('マイページ：その他の項目', () => {
  it('配信 URL は許可したサイトの https のみ、3 件まで登録できる（同じ URL は 1 つにまとめる）', async () => {
    const a = await loginAs(await makeUser());
    const two = ['https://www.twitch.tv/me', 'https://www.youtube.com/@me'];
    expect((await req('PATCH', '/api/me', { auth: a, body: { streamUrls: [...two, two[0]] } })).status).toBe(200);
    expect((await json(await req('GET', '/api/me', { auth: a }))).user.streamUrls).toEqual(two);
    expect((await req('PATCH', '/api/me', { auth: a, body: { streamUrls: ['https://evil.example/'] } })).status).toBe(422);
    const four = ['https://twitch.tv/a', 'https://twitch.tv/b', 'https://twitch.tv/c', 'https://twitch.tv/d'];
    expect((await req('PATCH', '/api/me', { auth: a, body: { streamUrls: four } })).status).toBe(422);
    expect((await req('PATCH', '/api/me', { auth: a, body: { streamUrls: [] } })).status).toBe(200);
    expect((await json(await req('GET', '/api/me', { auth: a }))).user.streamUrls).toEqual([]);
  });

  it('配信 URL が正しくないときは、何番目の欄が悪いのかをエラーに入れる', async () => {
    const a = await loginAs(await makeUser());
    const res = await req('PATCH', '/api/me', { auth: a, body: { streamUrls: ['https://www.twitch.tv/ok', 'daed'] } });
    expect(res.status).toBe(422);
    expect((await json(res)).message).toContain('配信 URL（2 つ目）');
  });

  it('よく使う時間は users の 1 列（JSON）に保存される', async () => {
    const id = await makeUser();
    const a = await loginAs(id);
    const presets = [{ label: '平日夜', start: '20:00', end: '24:00' }];
    expect((await req('PATCH', '/api/me', { auth: a, body: { timePresets: presets } })).status).toBe(200);
    const row = await env.DB.prepare('SELECT time_presets FROM users WHERE id = ?').bind(id).first<{ time_presets: string }>();
    expect(JSON.parse(row!.time_presets)).toEqual(presets);
    expect((await json(await req('GET', '/api/me', { auth: a }))).user.timePresets).toEqual(presets);
  });

  it('ログインしていなければ変更できない', async () => {
    expect((await req('PATCH', '/api/me', { body: { xAccount: 'abc' } })).status).toBe(401);
  });
});
