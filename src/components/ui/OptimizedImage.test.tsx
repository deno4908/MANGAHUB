import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import OptimizedImage from '@/components/ui/OptimizedImage';
import { ImageFailureContext } from './ImageFailureContext';

describe('OptimizedImage slow cover recovery', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('reports exhausted remote covers without reporting a primary failure that recovers', () => {
    const unavailable = vi.fn();
    const primary = 'https://uploads.mangadex.org/covers/test/outage.jpg';
    const fallback = 'https://api.example.com/api/manga/mangadex-cover/test';
    render(<ImageFailureContext.Provider value={unavailable}>
      <OptimizedImage src={primary} fallbackSrc={fallback} alt="Outage" priority />
    </ImageFailureContext.Provider>);
    const image = screen.getByRole('img', { name: 'Outage' });
    fireEvent.error(image);
    expect(image).toHaveAttribute('src', fallback);
    expect(unavailable).not.toHaveBeenCalled();
    fireEvent.error(image);
    expect(unavailable).toHaveBeenCalledWith(primary);
    expect(image.getAttribute('src')).toMatch(/\/no-cover(?:-dark)?\.svg$/);
    // A failed local placeholder must not restart the failed remote fallback.
    fireEvent.error(image);
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it('reports a stalled remote fallback to its page', () => {
    vi.useFakeTimers();
    const unavailable = vi.fn();
    render(<ImageFailureContext.Provider value={unavailable}>
      <OptimizedImage src="https://uploads.mangadex.org/covers/stalled.jpg"
        fallbackSrc="https://api.example.com/stalled.jpg" fallbackDelayMs={1000} alt="Stalled" priority />
    </ImageFailureContext.Provider>);
    act(() => vi.advanceTimersByTime(1000));
    expect(unavailable).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(12000));
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it('reports a stalled cover before switching directly to a local placeholder', () => {
    vi.useFakeTimers();
    const unavailable = vi.fn();
    render(<ImageFailureContext.Provider value={unavailable}>
      <OptimizedImage src="https://uploads.mangadex.org/covers/local-fallback.jpg"
        fallbackSrc="/no-cover.svg" fallbackDelayMs={1000} alt="Local fallback" priority />
    </ImageFailureContext.Provider>);
    act(() => vi.advanceTimersByTime(1000));
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('img', { name: 'Local fallback' }).getAttribute('src')).toMatch(/\/no-cover(?:-dark)?\.svg$/);
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
