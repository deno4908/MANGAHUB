import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCoverCache } from '@/lib/coverCache';

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

describe('managed MangaDex cover recovery', () => {
  const api = import.meta.env.VITE_API_URL || 'http://localhost:8000';
  const source = `${api}/api/manga/mangadex-cover/recovery-test`;
  const response = () => new Response(new Blob(['image'], { type: 'image/jpeg' }),
    { headers: { 'content-type': 'image/jpeg' } });
  beforeEach(() => {
    vi.useFakeTimers();
    let sequence = 0;
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => `blob:cover-${++sequence}`);
      static revokeObjectURL = vi.fn();
    });
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(async () => {
    cleanup();
    clearCoverCache();
    await Promise.resolve();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps a pending saved-cover download when metadata only updates its fallback', async () => {
    let complete!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const { rerender } = render(<OptimizedImage src={source} fallbackSrc="/no-cover.svg" alt="Saved cover" priority />);
    await act(async () => {});
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    rerender(<OptimizedImage src={source} fallbackSrc={`${api}/api/images/img?url=fresh-cover`} alt="Saved cover" priority />);
    await act(async () => {});
    expect(signal?.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => complete(response()));
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:cover-1');
  });

  it('uses the latest fallback if the existing download fails after metadata arrives', async () => {
    let fail!: (error: Error) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }))
      .mockResolvedValueOnce(response());
    const { rerender } = render(<OptimizedImage src={source} fallbackSrc="/no-cover.svg" alt="Saved recovery" priority />);
    await act(async () => {});
    const fallback = `${api}/api/images/img?url=latest-cover`;
    rerender(<OptimizedImage src={source} fallbackSrc={fallback} alt="Saved recovery" priority />);
    await act(async () => fail(new Error('Old cover unavailable')));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe(fallback);
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:cover-1');
  });

  it('lets a slow recovery download finish instead of rotating sources and aborting it', async () => {
    let complete!: (value: Response) => void;
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Temporary CDN error'))
      .mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    render(<OptimizedImage src={source} alt="Recovering" priority />);
    await act(async () => {});
    fireEvent.load(screen.getByRole('img'));
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1][1]?.signal?.aborted).toBe(false);
    await act(async () => { complete(response()); });
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:cover-1');
    fireEvent.load(screen.getByRole('img'));
    expect(document.querySelector('.animate-pulse')).toBeNull();
  });

  it('does not render an old revoked blob when retrying a decode failure', async () => {
    vi.mocked(fetch).mockImplementation(async () => response());
    render(<OptimizedImage src={source} alt="Decode" priority />);
    await act(async () => {});
    fireEvent.error(screen.getByRole('img'));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:cover-1');
    fireEvent.load(screen.getByRole('img'));
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:cover-2');
  });

  it('recovers an exhausted placeholder after the CDN returns without navigating away', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('CDN outage'));
    render(<OptimizedImage src={source} maxRetries={0} alt="Outage recovery" priority />);
    await act(async () => {});
    fireEvent.load(screen.getByRole('img'));
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    fireEvent.load(screen.getByRole('img'));
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.mocked(fetch).mockImplementation(async () => response());
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:cover-1');
    fireEvent.load(screen.getByRole('img'));
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
