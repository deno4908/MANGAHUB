type PageObserver = {
  near: () => void;
  visible: (value: boolean) => void;
};

const pages = new Map<Element, PageObserver>();
let preload: IntersectionObserver | undefined;
let viewport: IntersectionObserver | undefined;

/** Two observers for the whole reader, including chapters with hundreds of pages. */
export function observeReaderPage(element: Element, callbacks: PageObserver): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    callbacks.near();callbacks.visible(true);
    return () => {};
  }
  if (!preload) preload = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      pages.get(entry.target)?.near();
      // Near-view loading is a one-way transition. Later scrolls must not
      // restart an image or keep scheduling callbacks for loaded pages.
      preload?.unobserve(entry.target);
    }
  }, { rootMargin: '1000px 0px', threshold: 0 });
  if (!viewport) viewport = new IntersectionObserver(entries => {
    for (const entry of entries) pages.get(entry.target)?.visible(entry.isIntersecting);
  }, { rootMargin: '0px', threshold: .05 });
  pages.set(element, callbacks);
  preload.observe(element);viewport.observe(element);
  return () => {
    pages.delete(element);
    preload?.unobserve(element);viewport?.unobserve(element);
    if (!pages.size) {
      preload?.disconnect();viewport?.disconnect();
      preload = viewport = undefined;
    }
  };
}
