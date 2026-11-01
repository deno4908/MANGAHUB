import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import SuggestionCover from './SuggestionCover';
import type { Manga } from '@/types/manga';

vi.mock('@/components/ui/OptimizedImage', () => ({ default: ({ src, fallbackSrc, priority }: any) =>
  <img alt="suggestion" src={src} data-fallback={fallbackSrc} data-priority={String(priority)} /> }));
afterEach(cleanup);
it('uses a small proxied MangaDex cover with a current-cover fallback, loaded eagerly', () => {
  const id = 'f239fcd4-9f7f-4296-9e52-ee5a66a7e938';
  render(<SuggestionCover manga={{ id, cover: `https://uploads.mangadex.org/covers/${id}/old.jpg.512.jpg` } as Manga} />);
  const image = screen.getByRole('img');
  const src = new URL(image.getAttribute('src')!);
  expect(src.pathname).toBe('/api/images/img');
  expect(src.searchParams.get('url')).toContain('old.jpg.256.jpg');
  expect(image.getAttribute('data-fallback')).toContain(`/api/manga/mangadex-cover/${id}`);
  expect(image).toHaveAttribute('data-priority', 'true');
});
it('can recover missing QQ thumbnails through the source cover endpoint', () => {
  render(<SuggestionCover manga={{ id: 'qq-title-12345', cover: '' } as Manga} />);
  expect(screen.getByRole('img').getAttribute('src')).toContain('/api/manga/truyenqq/cover/qq-title-12345');
});
