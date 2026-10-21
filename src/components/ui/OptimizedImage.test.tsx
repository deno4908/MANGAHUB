import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import OptimizedImage from '@/components/ui/OptimizedImage';

describe('OptimizedImage slow cover recovery', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits before using the proxy and does not leave a stalled proxy skeleton forever', () => {
    vi.useFakeTimers();
    render(
      <OptimizedImage
        src="https://img.otruyenapi.com/uploads/comics/slow-cover.jpg"
        fallbackSrc="https://api.example.com/api/images/img?url=slow-cover"
        fallbackDelayMs={10_000}
        alt="Slow OTruyen cover"
        priority
      />,
    );

    const image = screen.getByRole('img', { name: 'Slow OTruyen cover' });
    expect(image).toHaveAttribute('src', 'https://img.otruyenapi.com/uploads/comics/slow-cover.jpg');

    act(() => vi.advanceTimersByTime(9_999));
    expect(image).toHaveAttribute('src', 'https://img.otruyenapi.com/uploads/comics/slow-cover.jpg');

    act(() => vi.advanceTimersByTime(1));
    expect(image).toHaveAttribute('src', 'https://api.example.com/api/images/img?url=slow-cover');

    act(() => vi.advanceTimersByTime(12_000));
    expect(image.getAttribute('src')).toMatch(/\/no-cover(?:-dark)?\.svg$/);
  });
});
