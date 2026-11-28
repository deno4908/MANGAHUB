import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ReaderImage from './ReaderImage';
import * as transport from '@/lib/imageTransport';
import { clearCoverCache, acquireReaderImage } from '@/lib/coverCache';

afterEach(() => {
  cleanup();
  clearCoverCache();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('uses the proxy for subsequent MangaDex pages after the same CDN host fails', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:recovered-mangadex-page');
    static revokeObjectURL = vi.fn();
  });
  const request = vi.spyOn(transport, 'fetchImageResponse').mockImplementation(async () =>
    new Response('image', { headers: { 'Content-Type': 'image/jpeg' } }));
  const first = render(<ReaderImage src="https://offline-reader.mangadex.network/data/hash/1.jpg" alt="First CDN page" index={0} imageFit="width" pageGap={0} priority />);
  expect(request).not.toHaveBeenCalled();
  fireEvent.error(screen.getByRole('img', { name: 'First CDN page' }));
  first.unmount();
  render(<ReaderImage src="https://offline-reader.mangadex.network/data/hash/2.jpg" alt="Next CDN page" index={1} imageFit="width" pageGap={0} priority />);
  await act(async () => {});
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toContain('/api/images/img?url=');
  expect(screen.getByRole('img', { name: 'Next CDN page' })).toHaveAttribute('src', 'blob:recovered-mangadex-page');
});

it('retries a protected QQ download and clears its cached private blob on access loss', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:reader-private-image');
    static revokeObjectURL = vi.fn();
  });
  const request = vi.spyOn(transport, 'fetchImageResponse').mockRejectedValueOnce(new Error('temporary source error'))
    .mockResolvedValue(new Response('image', { headers: { 'Content-Type': 'image/jpeg' } }));
  const api = import.meta.env.VITE_API_URL || 'http://localhost:8000';
  const view = render(<ReaderImage src={`${api}/api/manga/truyenqq/image/book-123/1/2`} alt="Protected page" index={1} imageFit="width" pageGap={0} priority />);
  await act(async () => {});
  expect(screen.queryByRole('button')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:reader-private-image');
  fireEvent.load(screen.getByRole('img'));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(request).toHaveBeenCalledTimes(2);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  view.unmount();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  clearCoverCache();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:reader-private-image');
});

it('silently retries transient decode/network errors and stops after a successful page', () => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  render(<ReaderImage src="https://cdn.example/page.jpg" alt="Retrying page" index={1} imageFit="width" pageGap={0} priority />);
  fireEvent.error(screen.getByRole('img'));
  expect(screen.queryByRole('button')).toBeNull();
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByRole('img').getAttribute('src')).toContain('retry=1');
  fireEvent.error(screen.getByRole('img'));
  act(() => vi.advanceTimersByTime(2000));
  fireEvent.load(screen.getByRole('img'));
  act(() => vi.advanceTimersByTime(90_000));
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByRole('img').getAttribute('src')).toContain('retry=2');
});

it('only offers manual retry after a bounded recovery window, and manual retry gets a fresh URL', () => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  render(<ReaderImage src="https://cdn.example/outage.jpg" alt="Outage page" index={0} imageFit="width" pageGap={0} priority />);
  for (const delay of [1000, 2000, 4000, 8000]) {
    fireEvent.error(screen.getByRole('img'));act(() => vi.advanceTimersByTime(delay));
    expect(screen.queryByRole('button')).toBeNull();
  }
  fireEvent.error(screen.getByRole('img'));
  act(() => vi.advanceTimersByTime(14_999));
  expect(screen.queryByRole('button')).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('img').getAttribute('src')).toContain('retry=5');
  fireEvent.load(screen.getByRole('img'));
  expect(screen.queryByRole('button')).toBeNull();
});

it('recovers a failed page automatically when the network returns', () => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  render(<ReaderImage src="https://cdn.example/offline.jpg" alt="Offline page" index={0} imageFit="width" pageGap={0} priority />);
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByRole('button')).toBeInTheDocument();
  act(() => window.dispatchEvent(new Event('online')));
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByRole('img').getAttribute('src')).toContain('retry=5');
});

it('lets the QQ proxy finish CDN fallback before retrying an image', () => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const src = 'http://localhost:8000/api/manga/truyenqq/image/truyen-123/1/1';
  render(<ReaderImage src={src} alt="Trang QQ" index={0} imageFit="width" pageGap={0} priority />);
  const image = screen.getByRole('img', { name: 'Trang QQ' });
  act(() => vi.advanceTimersByTime(20_000));
  expect(image).toHaveAttribute('src', src);
  fireEvent.load(image);
  act(() => vi.advanceTimersByTime(10_000));
  expect(image).toHaveAttribute('src', src);
  expect(screen.queryByText('Không thể tải ảnh')).not.toBeInTheDocument();
});


it('adopts an in-flight preload once and keeps downloading through visibility changes', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:shared-reader-page');
    static revokeObjectURL = vi.fn();
  });
  let finish!: (response: Response) => void;
  const request = vi.spyOn(transport, 'fetchImageResponse').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const api = import.meta.env.VITE_API_URL || 'http://localhost:8000';
  const src = `${api}/api/manga/truyenqq/image/book-123/1/3`;
  const preload = acquireReaderImage(src, 'prefetch');
  render(<ReaderImage src={src} alt="Shared page" index={2} imageFit="width" pageGap={0} priority />);
  await act(async () => {});
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1]?.signal?.aborted).toBe(false);
  await act(async () => {
    finish(new Response('page', { headers: { 'Content-Type': 'image/jpeg' } }));
    await preload.promise;
  });
  preload.release();
  expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:shared-reader-page');
  fireEvent.load(screen.getByRole('img'));
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(['truyenqq', 'mangadex'])('releases decoded %s reader blobs for bounded eviction without replacing displayed images or refetching', async source => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  let sequence = 0;
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => `blob:decoded-page-${++sequence}`);
    static revokeObjectURL = vi.fn();
  });
  const request = vi.spyOn(transport, 'fetchImageResponse').mockImplementation(async () => ({
    ok: true, headers: new Headers({ 'Content-Type': 'image/jpeg' }),
    blob: async () => ({ size: 4 * 1024 * 1024 }),
  }) as Response);
  const api = import.meta.env.VITE_API_URL || 'http://localhost:8000';
  render(<>{Array.from({ length: 7 }, (_, index) => <ReaderImage key={index}
    src={source === 'truyenqq' ? `${api}/api/manga/truyenqq/image/long-book-123/1/${index + 1}`
      : `${api}/api/images/img?url=${encodeURIComponent(`https://reader.mangadex.network/data/hash/${index + 1}.jpg`)}`}
    alt={`Decoded page ${index + 1}`} index={index} imageFit="width" pageGap={0} priority />)}</>);
  await act(async () => {});
  const images = screen.getAllByRole('img');
  expect(images).toHaveLength(7);
  const originalSources = images.map(image => image.getAttribute('src'));
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  for (const image of images) fireEvent.load(image);
  await act(async () => {});
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  expect(images.map(image => image.getAttribute('src'))).toEqual(originalSources);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(request).toHaveBeenCalledTimes(7);
  expect(screen.queryByRole('button')).toBeNull();
});
