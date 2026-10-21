import { CompactEncrypt, importJWK, type JWK } from 'jose';

export type CredentialPurpose = 'login' | 'register' | 'change-password' | 'reset-password';
export type CredentialChallenge = { nonce: string; public_key: JWK; expires_in: number };

export async function sealCredentials(
  fields: Record<string, string | undefined>,
  purpose: CredentialPurpose,
  challenge: CredentialChallenge,
): Promise<{ credential: string }> {
  if (!challenge?.nonce || !challenge.public_key?.kid || challenge.public_key.kty !== 'RSA') {
    throw new Error('Không thể khởi tạo bảo mật đăng nhập. Vui lòng thử lại.');
  }
  const key = await importJWK(challenge.public_key, 'RSA-OAEP-256');
  const payload = new TextEncoder().encode(JSON.stringify({ nonce: challenge.nonce, purpose, fields }));
  const credential = await new CompactEncrypt(payload)
    .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM', kid: challenge.public_key.kid })
    .encrypt(key);
  return { credential };
}

export function passwordStrengthError(password: string): string | null {
  const length = Array.from(password).length;
  return length >= 8 && length <= 128 ? null
    : 'Mật khẩu mới phải từ 8 đến 128 ký tự.';
}
