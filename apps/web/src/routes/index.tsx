// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useDemoMode } from '../features/demo/notice.js';
import { DemoPage } from '../features/demo/landing.js';
import { LoadingState } from '../components/ui/states.js';

export function HomePage() {
  const mode = useDemoMode();
  if (!mode) return <main id="main-content" className="p-4"><LoadingState /></main>;
  return mode === 'entry' ? <DemoPage /> : <Navigate to="/login" replace />;
}
export const Route = createFileRoute('/')({ component: HomePage });
