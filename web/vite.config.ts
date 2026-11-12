import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 画面は dist/client に出力し、Worker の静的アセットとして配信する
// （fileURLToPath を使うのは、Windows のドライブ文字 D:\ を正しく扱うため）
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    sourcemap: false,
    // 小さなファイルも data: URL に埋め込まない（セキュリティポリシーで data: のフォントを許可していないため）
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        // 適性レーン：既存の championLane の画面を、別のページとしてそのまま載せる（新しいタブで開く）
        lanes: fileURLToPath(new URL('./tools/lanes/index.html', import.meta.url)),
      },
    },
  },
});
