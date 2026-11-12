import { Box, Button, Group, Modal, Slider, Stack, Text } from '@mantine/core';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cropToSquare } from '../imageTools';

const VIEW = 280; // 調整画面の枠の大きさ（px）
const MAX_ZOOM = 4;

interface Props {
  bitmap: ImageBitmap | null;
  onCancel: () => void;
  onDone: (blob: Blob) => void;
  /** 丸く表示する画像（アイコン）なら true。枠の形の目安を出す */
  round?: boolean;
  /** 保存する画像の一辺（px） */
  outputSize?: number;
}

/** 切り抜く範囲をドラッグ（位置）とスライダー（拡大）で決める */
export function ImageCropper({ bitmap, onCancel, onDone, round = true, outputSize = 512 }: Props) {
  // 画面が開ききる前は描く先がまだ無いので、用意できた時点を状態として受け取り、そのときに必ず描く
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 }); // 枠に対する画像の左上の位置
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const base = bitmap ? VIEW / Math.min(bitmap.width, bitmap.height) : 1; // 枠を必ず埋める倍率
  const scale = base * zoom;
  const w = (bitmap?.width ?? 0) * scale;
  const h = (bitmap?.height ?? 0) * scale;
  // 画像が枠からはみ出さないように（必ず枠を埋める）
  const clamp = useCallback((x: number, y: number, ww = w, hh = h) => ({
    x: Math.min(0, Math.max(VIEW - ww, x)), y: Math.min(0, Math.max(VIEW - hh, y)),
  }), [w, h]);

  // 新しい画像を開いたら、中央・等倍から始める
  useEffect(() => {
    if (!bitmap) return;
    const s = VIEW / Math.min(bitmap.width, bitmap.height);
    setZoom(1);
    setPos({ x: (VIEW - bitmap.width * s) / 2, y: (VIEW - bitmap.height * s) / 2 });
  }, [bitmap]);

  useEffect(() => {
    const cv = canvas;
    if (!cv || !bitmap) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = VIEW * dpr;
    cv.height = VIEW * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, VIEW, VIEW);
    ctx.drawImage(bitmap, pos.x, pos.y, w, h);
    if (round) {
      // 丸く表示される範囲の外側を暗くする
      ctx.fillStyle = 'rgba(26, 29, 35, 0.55)';
      ctx.beginPath();
      ctx.rect(0, 0, VIEW, VIEW);
      ctx.arc(VIEW / 2, VIEW / 2, VIEW / 2, 0, Math.PI * 2, true);
      ctx.fill('evenodd');
    }
  }, [canvas, bitmap, pos, w, h, round]);

  // 拡大するときは、枠の中心にある場所を中心に保つ
  const changeZoom = (z: number) => {
    if (!bitmap) return;
    const cx = (VIEW / 2 - pos.x) / scale;
    const cy = (VIEW / 2 - pos.y) / scale;
    const ns = base * z;
    setZoom(z);
    setPos(clamp(VIEW / 2 - cx * ns, VIEW / 2 - cy * ns, bitmap.width * ns, bitmap.height * ns));
  };

  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y };
  };
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    setPos(clamp(drag.current.x + e.clientX - drag.current.px, drag.current.y + e.clientY - drag.current.py));
  };
  const onUp = () => { drag.current = null; };
  const onKey = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const d = e.shiftKey ? 40 : 10;
    const moves: Record<string, [number, number]> = { ArrowLeft: [d, 0], ArrowRight: [-d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    setPos((p) => clamp(p.x + m[0], p.y + m[1]));
  };

  const done = async () => {
    if (!bitmap) return;
    setBusy(true);
    try {
      onDone(await cropToSquare(bitmap, -pos.x / scale, -pos.y / scale, VIEW / scale, outputSize));
    } finally { setBusy(false); }
  };

  return (
    <Modal opened={Boolean(bitmap)} onClose={onCancel} title="表示する範囲を決める" centered>
      <Stack align="center" gap="md">
        <Text size="sm" c="var(--muted)">画像をドラッグして位置を、スライダーで大きさを調整してください。矢印キーでも動かせます。</Text>
        <Box style={{ width: VIEW, height: VIEW, borderRadius: 8, overflow: 'hidden', background: '#e3e6eb', touchAction: 'none' }}>
          <canvas ref={setCanvas} style={{ width: VIEW, height: VIEW, cursor: 'grab', display: 'block' }} tabIndex={0}
            role="img" aria-label="切り抜く範囲のプレビュー（ドラッグまたは矢印キーで移動）"
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey} />
        </Box>
        <Box w={VIEW}>
          <Text size="xs" mb={4} id="zoom-label">大きさ</Text>
          <Slider aria-labelledby="zoom-label" min={1} max={MAX_ZOOM} step={0.01} value={zoom} onChange={changeZoom} label={null} />
        </Box>
        <Group justify="flex-end" w="100%">
          <Button variant="default" onClick={onCancel}>やめる</Button>
          <Button onClick={done} loading={busy}>この範囲にする</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
