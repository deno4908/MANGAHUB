import { createElement, lazy, type ComponentType, type ComponentProps } from 'react';

export function isRouteAssetError(error: unknown) {
  return error instanceof Error && /Failed to fetch dynamically imported module|Importing a module script failed|Loading (?:CSS )?chunk|Unable to preload CSS/i.test(error.message);
}

const failedPages = new Set<() => void>();

/** React.lazy caches a rejection too; dropping only the preload promise is insufficient. */
export function retryFailedPages() {
  for (const reset of failedPages) reset();
  failedPages.clear();
}

/** Share an early route download with React.lazy; a failed preload can retry. */
export function lazyPage<T extends ComponentType>(loader: () => Promise<{ default: T }>) {
  let pending: Promise<{ default: T }> | undefined;
  const load = async () => {
    try { return await loader(); }
    catch (error) {
      // One retry only for transient asset failures, never a page render error.
      // Healthy routes make exactly one request; static assets bypass Workers.
      if (!isRouteAssetError(error) || (typeof navigator !== 'undefined' && navigator.onLine === false)) throw error;
      await new Promise(resolve => setTimeout(resolve, 350));
      return loader();
    }
  };
  const reset = () => { pending = undefined;page = lazy(preload); };
  const preload = () => pending ??= load().then(value => {
    failedPages.delete(reset);
    return value;
  }).catch(error => {
    pending = undefined;
    failedPages.add(reset);
    throw error;
  });
  let page = lazy(preload);
  const Page = (props: ComponentProps<T>) => createElement(page as ComponentType<ComponentProps<T>>, props);
  return Object.assign(Page, { preload });
}
