import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mangaApi } from '@/lib/api';
import { MANGADEX_TAGS } from '@/lib/mangaDexTags';
import { useMangaStore } from '@/store/mangaStore';
import { useSettingsStore } from '@/store/settingsStore';
import FilterPanel from './FilterPanel';

let client: QueryClient;
function mature(value: boolean) {
  useSettingsStore.setState(state => ({ settings: { ...state.settings,
    privacy: { ...state.settings.privacy, showMatureContent: value } } }));
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useMangaStore.getState().resetFilters();
  mature(false);
  vi.spyOn(mangaApi, 'getCategories').mockResolvedValue({ data: { items: [
    { slug: 'action', name: 'Action' }, { slug: 'ngon-tinh', name: 'Ngôn tình' },
    { slug: 'hentai', name: 'Hentai' }, { slug: 'manhwa', name: 'Manhwa' },
  ] } });
  vi.spyOn(mangaApi, 'getCategoryManga').mockResolvedValue({ data: { items: [] } });
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); mature(false); });
function show(url = '/manga?source=mangadex') {
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><FilterPanel /></MemoryRouter></QueryClientProvider>);
}

it('shows all 77 native MangaDex tags when mature is enabled without loading QQ categories', () => {
  mature(true);
  show();
  expect(MANGADEX_TAGS).toHaveLength(77);
  expect(new Set(MANGADEX_TAGS.map(tag => tag.slug)).size).toBe(77);
  const expectedNames = new Set(MANGADEX_TAGS.map(tag => tag.name));
  const buttonNames = screen.getAllByRole('button').map(button => button.textContent?.trim());
  expect(buttonNames.filter(name => expectedNames.has(name!))).toEqual(MANGADEX_TAGS.map(tag => tag.name));
  for (const name of ['Ngôn tình', 'Manhwa', 'Hentai', 'Ecchi', 'Smut']) {
    expect(buttonNames).not.toContain(name);
  }
  expect(mangaApi.getCategories).not.toHaveBeenCalled();
  expect(screen.getByRole('heading', { name: 'Định dạng' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Chủ đề' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: "Boys' Love" }));
  expect(useMangaStore.getState().filters.genres).toEqual(['boys-love']);
  expect(mangaApi.getCategoryManga).not.toHaveBeenCalled();
});

it('reacts immediately to the Mature preference and keeps ordinary native tags visible', () => {
  show();
  expect(screen.queryByRole('button', { name: 'Sexual Violence' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Action' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: "Girls' Love" })).toBeInTheDocument();
  act(() => mature(true));
  expect(screen.getByRole('button', { name: 'Sexual Violence' })).toBeInTheDocument();
  act(() => mature(false));
  expect(screen.queryByRole('button', { name: 'Sexual Violence' })).not.toBeInTheDocument();
  expect(mangaApi.getCategories).not.toHaveBeenCalled();
});

it('keeps QQ genres separate and applies its mature preference without re-fetching', async () => {
  show('/manga');
  await screen.findByRole('button', { name: 'Ngôn tình' });
  expect(screen.queryByRole('button', { name: 'Villainess' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Hentai' })).not.toBeInTheDocument();
  act(() => mature(true));
  expect(screen.getByRole('button', { name: 'Hentai' })).toBeInTheDocument();
  expect(mangaApi.getCategories).toHaveBeenCalledTimes(1);
});
