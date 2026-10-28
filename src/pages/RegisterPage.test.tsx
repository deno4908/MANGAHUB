import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RegisterPage from './RegisterPage';

const mocks = vi.hoisted(() => ({ register: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ authApi: { register: mocks.register } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/components/manga/BrandLogo', () => ({ default: () => <div>MangaHub</div> }));
vi.mock('@/components/security/ReCaptchaV2', async () => {
  const { forwardRef } = await import('react');
  return { default: forwardRef(() => null), isRecaptchaConfigured: () => false };
});
beforeEach(() => { mocks.register.mockReset().mockResolvedValue({}); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

function form() {
  render(<MemoryRouter><RegisterPage /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'Độc giả vui vẻ !' } });
  fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'reader@example.com' } });
  fireEvent.change(screen.getByLabelText('Mật khẩu', { exact: true }), { target: { value: 'violet canoe lunar orchard' } });
  fireEvent.change(screen.getByLabelText('Xác nhận mật khẩu'), { target: { value: 'violet canoe lunar orchard' } });
  return screen.getByRole('button', { name: 'Đăng ký', exact: true });
}

it('keeps password checkmarks without a meter or username composition checklist', async () => {
  const submit = form();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByText('Không chứa khoảng trắng')).toBeNull();
  expect(screen.getAllByRole('list', { name: 'Yêu cầu mật khẩu' })).toHaveLength(1);
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  await waitFor(() => expect(mocks.register).toHaveBeenCalledWith('reader@example.com', 'violet canoe lunar orchard', 'Độc giả vui vẻ !', 'Độc giả vui vẻ !', ''));
});

it('shows the server duplicate-username response instead of imposing character rules', async () => {
  mocks.register.mockRejectedValue(new Error('Username đã tồn tại'));
  fireEvent.click(form());
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'Username đã tồn tại' })));
});
