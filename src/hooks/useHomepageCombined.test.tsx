import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { mangaApi } from '@/lib/api';
import { useHomepageCombined } from './useApi';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('renders the home catalog while featured titles are still waiting upstream', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = { data: { items: [{ slug: 'book-123', name: 'Book', source: 'truyenqq' }],
    params: { pagination: { currentPage: 1, totalItemsPerPage: 1, totalItems: 1 } } } };
  let finishFeatured!: (value: unknown) => void;
  vi.spyOn(mangaApi, 'getFeatured').mockImplementation(() => new Promise(resolve => { finishFeatured = resolve; }));
  const home = vi.spyOn(mangaApi, 'getHomepage').mockResolvedValue({ latest: page, ongoing: page });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => useHomepageCombined(), { wrapper });
  await waitFor(() => expect(result.current.data?.latest.items[0].title).toBe('Book'));
  expect(result.current.isLoading).toBe(false);
  expect(home).toHaveBeenCalledWith();
  expect(result.current.data?.featured).toBeUndefined();
  await act(async () => { finishFeatured(page); });
  await waitFor(() => expect(result.current.data?.featured?.items[0].title).toBe('Book'));
  unmount();
  client.clear();
});
