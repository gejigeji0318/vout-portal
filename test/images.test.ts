import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { app } from '../src/index';
import { detectImageType, stripMetadata } from '../src/services/images';
import { setClockForTest } from '../src/lib/time';
import { addMember, type Auth, json, loginAs, makeTournament, makeUser, ORIGIN, req } from './helpers';

const enc = new TextEncoder();
const bytes = (...parts: (number[] | string | Uint8Array)[]) => {
  const arr = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arr.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arr) { out.set(a, o); o += a.length; }
  return out;
};
const text = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const seg = (marker: number, payload: Uint8Array | string) => {
  const p = typeof payload === 'string' ? enc.encode(payload) : payload;
  return bytes([0xff, marker, (p.length + 2) >> 8, (p.length + 2) & 0xff], p);
};
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u32le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const pngChunk = (name: string, data: string) => bytes(u32be(data.length), name, data, [0, 0, 0, 0]);

/** 撮影場所の情報（GPS）とコメントを含む JPEG */
export const jpegWithGps = () => bytes([0xff, 0xd8], seg(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0'), seg(0xe1, 'Exif\0\0GPSLatitude=35.68'),
  seg(0xfe, 'secret comment'), seg(0xdb, new Uint8Array(65)), seg(0xda, new Uint8Array(6)), 'PIXELDATA', [0xff, 0xd9]);
const pngWithText = () => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pngChunk('IHDR', '0123456789abc'),
  pngChunk('tEXt', 'Location\0Tokyo'), pngChunk('eXIf', 'GPSDATA'), pngChunk('IDAT', 'PIXELDATA'), pngChunk('IEND', ''));
const webpWithExif = () => {
  const chunk = (name: string, data: Uint8Array | string) => {
    const d = typeof data === 'string' ? enc.encode(data) : data;
    return bytes(name, u32le(d.length), d, d.length % 2 ? [0] : []);
  };
  const body = bytes('WEBP', chunk('VP8X', Uint8Array.from([0x0c | 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0])), chunk('VP8 ', 'PIXELDATA'), chunk('EXIF', 'GPSDATA'), chunk('XMP ', '<x:gps/>'));
  return bytes('RIFF', u32le(body.length), body);
};

describe('画像の種類の判定（拡張子ではなく中身で見る）', () => {
  it('PNG・JPEG・WebP だけを受け付ける', () => {
    expect(detectImageType(jpegWithGps())).toBe('image/jpeg');
    expect(detectImageType(pngWithText())).toBe('image/png');
    expect(detectImageType(webpWithExif())).toBe('image/webp');
    expect(detectImageType(enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(detectImageType(enc.encode('GIF89a......'))).toBeNull();
    expect(detectImageType(enc.encode('<html><script>alert(1)</script></html>'))).toBeNull();
  });
});

describe('撮影場所などの情報を取り除く', () => {
  it('JPEG：EXIF（GPS）とコメントが消え、画像本体は残る', () => {
    const out = text(stripMetadata(jpegWithGps(), 'image/jpeg'));
    expect(out).not.toContain('GPS');
    expect(out).not.toContain('Exif');
    expect(out).not.toContain('secret');
    expect(out).toContain('JFIF');
    expect(out).toContain('PIXELDATA');
  });
  it('PNG：テキスト情報と EXIF のチャンクが消え、画像本体は残る', () => {
    const out = text(stripMetadata(pngWithText(), 'image/png'));
    expect(out).not.toContain('Location');
    expect(out).not.toContain('GPS');
    expect(out).toContain('IDAT');
    expect(out).toContain('PIXELDATA');
  });
  it('WebP：EXIF と XMP が消え、ファイルの長さと目印のフラグが正しく直る', () => {
    const out = stripMetadata(webpWithExif(), 'image/webp');
    const t = text(out);
    expect(t).not.toContain('GPS');
    expect(t).not.toContain('gps');
    expect(t).toContain('PIXELDATA');
    expect(new DataView(out.buffer, out.byteOffset).getUint32(4, true)).toBe(out.length - 8);
    expect(out[20]! & 0x0c).toBe(0);
  });
  it('壊れた画像はエラーにする', () => {
    expect(() => stripMetadata(bytes([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), 'image/jpeg')).toThrow();
  });
});

async function upload(auth: Auth, data: Uint8Array, name = 'icon.jpg'): Promise<Response> {
  const fd = new FormData();
  fd.append('file', new File([data], name));
  const headers = new Headers({ Cookie: auth.cookie, Origin: ORIGIN, 'X-CSRF-Token': auth.csrf });
  return app.fetch(new Request(`${ORIGIN}/api/me/icon`, { method: 'POST', headers, body: fd }), env,
    { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext);
}

async function staff(): Promise<Auth> {
  const t = await makeTournament(3);
  const id = await makeUser();
  await addMember(t.id, id, 'staff');
  return loginAs(id);
}

describe('運営メンバーのアイコン', () => {
  it('運営メンバーはアップロードでき、保存された画像から撮影場所の情報が消えている', async () => {
    const a = await staff();
    const res = await upload(a, jpegWithGps());
    expect(res.status).toBe(200);
    const { iconUrl } = await json(res);
    expect(iconUrl).toMatch(/^\/img\/[0-9A-Z]{26}\?exp=\d+&sig=[0-9a-f]{64}$/);
    const img = await req('GET', iconUrl);
    expect(img.status).toBe(200);
    expect(img.headers.get('Content-Type')).toBe('image/jpeg');
    expect(img.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(img.headers.get('Content-Security-Policy')).toContain('sandbox');
    const body = text(new Uint8Array(await img.arrayBuffer()));
    expect(body).not.toContain('GPS');
    expect(body).toContain('PIXELDATA');
  });

  it('選手はアイコンを設定できない', async () => {
    const t = await makeTournament(3);
    const id = await makeUser();
    await addMember(t.id, id, 'player', t.teams[0]!);
    expect((await upload(await loginAs(id), jpegWithGps())).status).toBe(403);
  });

  it('画像でないもの・SVG・GIF・5MB を超えるものは受け付けない', async () => {
    const a = await staff();
    expect((await upload(a, enc.encode('<svg><script>alert(1)</script></svg>'), 'x.png')).status).toBe(422);
    expect((await upload(a, enc.encode('GIF89a......'), 'x.gif')).status).toBe(422);
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set([0xff, 0xd8, 0xff], 0);
    expect((await upload(a, big)).status).toBe(422);
  });

  it('URL の署名を改ざんしたもの・期限切れ・他の画像の署名は見られない', async () => {
    const a = await staff();
    const { iconUrl } = await json(await upload(a, jpegWithGps()));
    const flipped = iconUrl.slice(0, -1) + (iconUrl.endsWith('0') ? '1' : '0');
    expect((await req('GET', flipped)).status).toBe(403);
    const other = (await json(await upload(await staff(), pngWithText(), 'a.png'))).iconUrl as string;
    const swapped = other.replace(/\/img\/[0-9A-Z]{26}/, iconUrl.match(/\/img\/[0-9A-Z]{26}/)![0]);
    expect((await req('GET', swapped)).status).toBe(403);
    const later = Date.now() + 31 * 60 * 1000;
    setClockForTest(() => new Date(later));
    expect((await req('GET', iconUrl)).status).toBe(403);
  });

  it('アイコンを差し替えると古い画像は見られなくなり、削除もできる', async () => {
    const a = await staff();
    const first = (await json(await upload(a, jpegWithGps()))).iconUrl as string;
    await upload(a, pngWithText(), 'b.png');
    expect((await req('GET', first)).status).toBe(404);
    expect((await req('DELETE', '/api/me/icon', { auth: a })).status).toBe(200);
    expect((await json(await req('GET', '/api/me', { auth: a }))).user.iconUrl).toBeNull();
  });

  it('自分の情報に、R2 上の保存場所は含まれない', async () => {
    const a = await staff();
    await upload(a, jpegWithGps());
    const t = JSON.stringify(await json(await req('GET', '/api/me', { auth: a })));
    expect(t).not.toContain('r2_key');
    expect(t).not.toContain('images/');
  });
});
