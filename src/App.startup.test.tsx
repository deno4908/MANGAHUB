import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppRouter } from './App';
import { siteAccessApi, systemApi } from '@/lib/api';

const session = vi.hoisted(() => ({
  user: null, isLoggedIn: false, hasCheckedSession: true, isRestoringSession: false,
  loadUser: vi.fn(), logout: vi.fn(), fetchNotifications: vi.fn(),
}));
vi.mock('@/store/userStore', () => ({ useUserStore: (select?: (value: typeof session) => unknown) => select ? select(session) : session }));
vi.mock('@/store/settingsStore', () => ({ useSettingsStore: (select: (value: unknown) => unknown) => select({ loadSettings: vi.fn() }) }));
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, hasBanLock: () => false, systemApi: { getMaintenance: vi.fn() }, siteAccessApi: { getStatus: vi.fn() } };
});
vi.mock('@/hooks/useCatalogUpdates', () => ({ CatalogUpdates: () => null }));
vi.mock('./components/manga/Navbar', () => ({ default: () => null }));
vi.mock('./components/manga/Footer', () => ({ default: () => null }));
vi.mock('./pages/Index', () => ({ default: () => <div data-testid="home-content" /> }));
const libraryImports = vi.hoisted(() => ({ following: vi.fn(), history: vi.fn(), bookmarks: vi.fn() }));
vi.mock('./pages/FollowingPage', () => { libraryImports.following(); return { default: () => <div data-testid="private-library" /> }; });
vi.mock('./pages/HistoryPage', () => { libraryImports.history(); return { default: () => <div data-testid="private-library" /> }; });
vi.mock('./pages/BookmarksPage', () => { libraryImports.bookmarks(); return { default: () => <div data-testid="private-library" /> }; });


function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal('scrollTo', vi.fn());
});
afterEach(() => { cleanup(); client.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const allow = { enabled: true, allowed: true, authenticated: true, message: '', access_expires_at: Date.now() + 600_000 };
function start() {
  render(<QueryClientProvider client={client}><MemoryRouter><AppRouter /></MemoryRouter></QueryClientProvider>);
}

it.each(['maintenance', 'access'])('starts both checks together and keeps home hidden until %s also finishes', async last => {
  const maintenance = deferred(), access = deferred();
  vi.mocked(systemApi.getMaintenance).mockReturnValue(maintenance.promise);
  vi.mocked(siteAccessApi.getStatus).mockReturnValue(access.promise);
  start();
  await waitFor(() => {
    expect(systemApi.getMaintenance).toHaveBeenCalledTimes(1);
    expect(siteAccessApi.getStatus).toHaveBeenCalledTimes(1);
  });
  await act(async () => {
    if (last === 'maintenance') access.resolve(allow);
    else maintenance.resolve({ enabled: false });
  });
  expect(screen.queryByTestId('home-content')).toBeNull();
  await act(async () => { access.resolve(allow); maintenance.resolve({ enabled: false }); });
  expect(await screen.findByTestId('home-content')).toBeInTheDocument();
  expect(siteAccessApi.getStatus).toHaveBeenCalledTimes(1);
});

it('keeps a denied visitor blocked after the parallel maintenance check finishes', async () => {
  vi.mocked(systemApi.getMaintenance).mockResolvedValue({ enabled: false });
  vi.mocked(siteAccessApi.getStatus).mockResolvedValue({ ...allow, allowed: false, authenticated: false });
  start();
  await waitFor(() => expect(siteAccessApi.getStatus).toHaveBeenCalledTimes(1));
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByTestId('home-content')).toBeNull();
});

it('keeps maintenance enabled even when access is allowed', async () => {
  vi.mocked(systemApi.getMaintenance).mockResolvedValue({ enabled: true, message: 'Scheduled work' });
  vi.mocked(siteAccessApi.getStatus).mockResolvedValue(allow);
  start();
  await screen.findByText('Scheduled work');
  expect(screen.queryByTestId('home-content')).toBeNull();
});


it.each(['following', 'history', 'bookmarks'] as const)('downloads only the requested %s page code while access remains pending', async page => {
  const pending = deferred();
  vi.mocked(systemApi.getMaintenance).mockReturnValue(pending.promise);
  vi.mocked(siteAccessApi.getStatus).mockReturnValue(pending.promise);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/' + page]}><AppRouter /></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(libraryImports[page]).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId('private-library')).toBeNull();
  for (const other of ['following', 'history', 'bookmarks'] as const) {
    if (other !== page) expect(libraryImports[other]).not.toHaveBeenCalled();
  }
});
