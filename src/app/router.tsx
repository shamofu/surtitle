// SPDX-License-Identifier: GPL-3.0-or-later
import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { AppShell } from './Shell';
import { LibraryPage } from '../features/library/LibraryPage';
import { StudyPage } from '../features/study/StudyPage';
import { CardsPage } from '../features/cards/CardsPage';
import { ReviewPage } from '../features/cards/ReviewPage';
import { SettingsPage } from '../features/settings/SettingsPage';

const rootRoute = createRootRoute({ component: AppShell });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: LibraryPage,
});
const studyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/study/$mediaId',
  validateSearch: (search: Record<string, unknown>): { resume?: string } => ({ resume: typeof search.resume === 'string' ? search.resume : undefined }),
  component: StudyPage,
});
const cardsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cards',
  component: CardsPage,
});
const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/review',
  component: ReviewPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  validateSearch: (search: Record<string, unknown>): { resume?: string } => ({ resume: typeof search.resume === 'string' ? search.resume : undefined }),
  component: SettingsPage,
});
export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    studyRoute,
    cardsRoute,
    reviewRoute,
    settingsRoute,
  ]),
  // The shell scrolls this element, not the window. Start each new page above
  // its native player instead of inheriting the previous page's scroll offset.
  scrollToTopSelectors: ['.page-content'],
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
