import { Loader, Text, Title } from '@mantine/core';
import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { UserLayout } from './components/UserLayout';

// 管理者画面は別のファイルに分け、参加者が開いたときには読み込まない
const AdminLayout = lazy(() => import('./components/AdminLayout').then((m) => ({ default: m.AdminLayout })));
const MembersPage = lazy(() => import('./pages/admin/MembersPage').then((m) => ({ default: m.MembersPage })));
const CoachDraftPage = lazy(() => import('./draft/screens').then((m) => ({ default: m.CoachDraftPage })));
const AdminDraftPage = lazy(() => import('./draft/screens').then((m) => ({ default: m.AdminDraftPage })));
const StreamDraftPage = lazy(() => import('./draft/screens').then((m) => ({ default: m.StreamDraftPage })));
const ContentPage = lazy(() => import('./pages/admin/ContentPage').then((m) => ({ default: m.ContentPage })));
const SystemPage = lazy(() => import('./pages/admin/SystemPage').then((m) => ({ default: m.SystemPage })));
import { MyPage } from './pages/MyPage';
import { TopPage } from './pages/TopPage';
import { AboutPage } from './pages/AboutPage';
import { OverviewPage } from './pages/OverviewPage';
import { RulesPage } from './pages/RulesPage';
import { NewsDetailPage, NewsListPage } from './pages/NewsPages';
import { PrivacyPage } from './pages/PrivacyPage';
import { InquiryPage } from './pages/InquiryPage';
import { EntryPage } from './pages/EntryPage';

function NotFound() {
  return (<><Title order={1} mb="sm">ページが見つかりません</Title><Text>URL を確認するか、メニューから移動してください。</Text></>);
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Loader m="xl" />}>
      <Routes>
        <Route element={<UserLayout />}>
          <Route index element={<TopPage />} />
          <Route path="me" element={<MyPage />} />
          <Route path="about" element={<AboutPage />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="rules" element={<RulesPage />} />
          <Route path="news" element={<NewsListPage />} />
          <Route path="news/:id" element={<NewsDetailPage />} />
          <Route path="privacy" element={<PrivacyPage />} />
          <Route path="inquiries" element={<InquiryPage />} />
          <Route path="entry" element={<EntryPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
        {/* ドラフトは画面全体を使う（既存のドラフトシステムと同じ見た目） */}
        <Route path="draft" element={<CoachDraftPage />} />
        <Route path="draft/stream" element={<StreamDraftPage />} />
        <Route path="admin/draft" element={<AdminDraftPage />} />
        <Route path="admin" element={<AdminLayout />}>
          <Route index element={<MembersPage />} />
          <Route path="content" element={<ContentPage />} />
          <Route path="system" element={<SystemPage />} />
        </Route>
      </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
