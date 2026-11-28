import { afterEach, expect, it, vi } from 'vitest';
import { observeReaderPage } from './readerViewport';

afterEach(() => vi.unstubAllGlobals());

it('shares two observers for a long mobile chapter and handles every entry in a batch', () => {
  const observers: Array<{ callback: IntersectionObserverCallback; observe: ReturnType<typeof vi.fn>;
    unobserve: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('IntersectionObserver', class {
    observe = vi.fn();unobserve = vi.fn();disconnect = vi.fn();
    constructor(public callback: IntersectionObserverCallback) { observers.push(this); }
  });
  const elements = Array.from({ length: 200 }, () => document.createElement('div'));
  const callbacks = elements.map(() => ({ near: vi.fn(), visible: vi.fn() }));
  const stop = elements.map((element, index) => observeReaderPage(element, callbacks[index]));
  try {
    expect(observers).toHaveLength(2);
    expect(observers[0].observe).toHaveBeenCalledTimes(200);
    const entries = [0, 1, 2].map(index => ({ target: elements[index], isIntersecting: index < 2 })) as IntersectionObserverEntry[];
    observers[0].callback(entries, observers[0] as unknown as IntersectionObserver);
    expect(callbacks.map(row => row.near.mock.calls.length).slice(0, 4)).toEqual([1, 1, 0, 0]);
    expect(observers[0].unobserve).toHaveBeenCalledTimes(2);
    observers[1].callback(entries, observers[1] as unknown as IntersectionObserver);
    expect(callbacks[0].visible).toHaveBeenCalledWith(true);
    expect(callbacks[1].visible).toHaveBeenCalledWith(true);
    expect(callbacks[2].visible).toHaveBeenCalledWith(false);
    stop[0]();
    observers[1].callback([entries[0]], observers[1] as unknown as IntersectionObserver);
    expect(callbacks[0].visible).toHaveBeenCalledTimes(1);
    for (const release of stop.slice(1)) release();
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(observers[1].disconnect).toHaveBeenCalledTimes(1);
    const next = observeReaderPage(document.createElement('div'), { near: vi.fn(), visible: vi.fn() });
    expect(observers).toHaveLength(4);
    next();
  } finally { for (const release of stop) release(); }
});

it('keeps reading usable on browsers without IntersectionObserver', () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  const callbacks = { near: vi.fn(), visible: vi.fn() };
  observeReaderPage(document.createElement('div'), callbacks)();
  expect(callbacks.near).toHaveBeenCalledOnce();
  expect(callbacks.visible).toHaveBeenCalledWith(true);
});
