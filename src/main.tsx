// SPDX-License-Identifier: GPL-3.0-or-later
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { AppProvider } from './context';
import { AppShell } from './App';
import { LibraryPage } from './pages/Library';
import { StudyPage } from './pages/Study';
import { CardsPage, ReviewPage } from './pages/Cards';
import { SettingsPage } from './pages/Settings';
import './styles.css';

const rootRoute = createRootRoute({ component: AppShell });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: LibraryPage });
const studyRoute = createRoute({ getParentRoute: () => rootRoute, path: '/study/$mediaId', component: StudyPage });
const cardsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/cards', component: CardsPage });
const reviewRoute = createRoute({ getParentRoute: () => rootRoute, path: '/review', component: ReviewPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage });
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, studyRoute, cardsRoute, reviewRoute, settingsRoute]) });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 2000 } } });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><QueryClientProvider client={queryClient}><AppProvider><RouterProvider router={router} /></AppProvider></QueryClientProvider></React.StrictMode>,
);
