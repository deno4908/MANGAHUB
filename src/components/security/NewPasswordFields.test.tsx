import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { NewPasswordFields, usePasswordAssessment } from './NewPasswordFields';

afterEach(cleanup);
function Form() {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const assessment = usePasswordAssessment(password);
  return <><NewPasswordFields password={password} confirmation={confirmation} onPasswordChange={setPassword}
    onConfirmationChange={setConfirmation} assessment={assessment} />
    <button disabled={!assessment.accepted || password !== confirmation}>Lưu mật khẩu</button></>;
}

it('shows animated strength and matching feedback, rejecting long but predictable passwords', async () => {
  render(<Form />);
  expect(screen.queryByRole('progressbar')).toBeNull();
  const password = screen.getByLabelText('Mật khẩu mới');
  const confirmation = screen.getByLabelText('Xác nhận mật khẩu');
  fireEvent.change(password, { target: { value: 'a'.repeat(20) } });
  fireEvent.change(confirmation, { target: { value: 'a'.repeat(20) } });
  expect(screen.getByRole('progressbar', { name: 'Độ mạnh mật khẩu' })).toBeInTheDocument();
  expect(screen.getByRole('list', { name: 'Yêu cầu mật khẩu' })).toBeInTheDocument();
  expect(screen.getByText('Mật khẩu khớp')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Lưu mật khẩu' })).toBeDisabled();
  fireEvent.change(password, { target: { value: 'violet canoe lunar orchard' } });
  expect(screen.getByText('Mật khẩu không khớp')).toBeInTheDocument();
  fireEvent.change(confirmation, { target: { value: 'violet canoe lunar orchard' } });
  expect(screen.getByRole('button', { name: 'Lưu mật khẩu' })).toBeEnabled();
  expect(password).toHaveAttribute('autocomplete', 'new-password');
  fireEvent.click(screen.getByRole('button', { name: 'Hiện mật khẩu' }));
  expect(password).toHaveAttribute('type', 'text');
  expect(confirmation).toHaveAttribute('type', 'text');
  fireEvent.change(password, { target: { value: '' } });
  await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
});
