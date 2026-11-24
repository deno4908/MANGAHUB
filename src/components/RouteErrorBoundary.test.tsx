import { Suspense } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import RouteErrorBoundary from './RouteErrorBoundary';
import { lazyPage, retryFailedPages } from '@/lib/lazyPage';

afterEach(() => { cleanup();retryFailedPages();vi.restoreAllMocks(); });

it('recreates a rejected React.lazy payload on retry without requiring a page reload', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const loader = vi.fn().mockRejectedValueOnce(new Error('temporary route failure'))
    .mockResolvedValue({ default: () => <div>Reader restored</div> });
  const Page = lazyPage(loader);
  render(<MemoryRouter><RouteErrorBoundary resetKey="/chapter/example">
    <Suspense fallback={<div>Loading</div>}><Page /></Suspense>
  </RouteErrorBoundary></MemoryRouter>);
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.queryByText(/frontend vừa được cập nhật/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
  expect(await screen.findByText('Reader restored')).toBeInTheDocument();
  expect(loader).toHaveBeenCalledTimes(2);
});

it('does not retry rendering code automatically or claim a new frontend release', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const Broken = () => { throw new Error('application error'); };
  const loader = vi.fn().mockResolvedValue({ default: Broken });
  const Page = lazyPage(loader);
  render(<MemoryRouter><RouteErrorBoundary resetKey="/">
    <Suspense fallback={null}><Page /></Suspense>
  </RouteErrorBoundary></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('lỗi tải dữ liệu hoặc kết nối');
  expect(loader).toHaveBeenCalledTimes(1);
});
