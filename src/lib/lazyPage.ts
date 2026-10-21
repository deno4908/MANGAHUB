import { lazy, type ComponentType } from 'react';

/** Share an early route download with React.lazy; a failed preload can retry. */
export function lazyPage<T extends ComponentType>(loader: () => Promise<{ default: T }>) {
  let pending: Promise<{ default: T }> | undefined;
  const preload = () => pending ??= loader().catch(error => {
    pending = undefined;
    throw error;
  });
  return Object.assign(lazy(preload), { preload });
}
