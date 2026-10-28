import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ReaderImage from './ReaderImage';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('waits for a cold IMGX render instead of replacing the image request every few seconds', () => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  const src = 'http://localhost:8000/api/manga/moetruyen/image/moe-1048/10/0';
  render(<ReaderImage src={src} alt="Trang Mòe" index={0} imageFit="width" pageGap={0} priority />);
  const image = screen.getByRole('img', { name: 'Trang Mòe' });
  act(() => vi.advanceTimersByTime(60_000));
  expect(image).toHaveAttribute('src', src);
  fireEvent.load(image);
  act(() => vi.advanceTimersByTime(20_000));
  expect(screen.queryByText('Không thể tải ảnh')).not.toBeInTheDocument();
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
