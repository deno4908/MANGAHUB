import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AuthCallbackPage from './AuthCallbackPage';

const mocks = vi.hoisted(() => ({ reset: vi.fn(), token: vi.fn(), logout: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ authApi: { resetPassword: mocks.reset }, setTokens: mocks.token }));
vi.mock('@/store/userStore', () => ({ useUserStore: { getState: () => ({ logout: mocks.logout }) } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/components/manga/BrandLogo', () => ({ default: () => <div>MangaHub</div> }));
beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  window.history.replaceState(null, '', '/auth/callback#access_token=test-recovery-session&type=recovery');
  mocks.reset.mockResolvedValue({ requires_relogin: true });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); window.history.replaceState(null, '', '/'); });

it('uses the same checklist as registration and clears the signed-in account after a successful reset', async () => {
  vi.useFakeTimers();
  render(<MemoryRouter><AuthCallbackPage /></MemoryRouter>);
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  expect(window.location.hash).toBe('');
  expect(mocks.token).toHaveBeenCalledWith('test-recovery-session');
  const password = screen.getByLabelText('Mật khẩu mới');
  const confirmation = screen.getByLabelText('Xác nhận mật khẩu');
  const submit = screen.getByRole('button', { name: 'Đặt lại mật khẩu' });
  fireEvent.change(password, { target: { value: 'Password123!' } });
  fireEvent.change(confirmation, { target: { value: 'Password123!' } });
  expect(submit).toBeDisabled();
  expect(screen.getByRole('progressbar', { name: 'Độ mạnh mật khẩu' })).toBeInTheDocument();
  fireEvent.change(password, { target: { value: 'violet canoe lunar orchard' } });
  expect(submit).toBeDisabled();
  fireEvent.change(confirmation, { target: { value: 'violet canoe lunar orchard' } });
  expect(submit).toBeEnabled();
  await act(async () => { fireEvent.click(submit); await vi.advanceTimersByTimeAsync(50); });
  expect(mocks.reset).toHaveBeenCalledWith('violet canoe lunar orchard');
  expect(mocks.logout).toHaveBeenCalledWith('global', { server: false });
  expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Đặt lại mật khẩu thành công!' }));
});
