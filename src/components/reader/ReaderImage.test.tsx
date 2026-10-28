import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ReaderImage from './ReaderImage';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
