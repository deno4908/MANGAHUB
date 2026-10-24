import zxcvbn from 'zxcvbn';

export type PasswordAssessment = {
  lengthValid: boolean;
  score: number;
  accepted: boolean;
};

// Keep this aligned with backend/flask_app/auth/credentials.py. This module is
// imported by password forms only; its dictionary stays out of the home bundle.
export function assessPassword(password: string): PasswordAssessment {
  const length = Array.from(password).length;
  const lengthValid = length >= 8 && length <= 128;
  const score = password && length <= 128
    ? zxcvbn(password, ['mangahub', 'truyenqq', 'matkhau']).score : 0;
  return { lengthValid, score, accepted: lengthValid && score >= 3 };
}

export function passwordStrengthError(password: string): string | null {
  const result = assessPassword(password);
  if (!result.lengthValid) return 'Mật khẩu mới phải từ 8 đến 128 ký tự.';
  return result.accepted ? null
    : 'Mật khẩu quá dễ đoán. Hãy dùng nhiều từ không liên quan hoặc một chuỗi ngẫu nhiên dài hơn.';
}
