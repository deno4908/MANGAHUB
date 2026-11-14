import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ReaderImage from './ReaderImage';
import * as transport from '@/lib/imageTransport';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('retries a protected QQ download in background and releases its private blob on unmount', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
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
  view.unmount();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:reader-private-image');
});

it('silently retries transient decode/network errors and stops after a successful page', () => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
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
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
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
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
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
