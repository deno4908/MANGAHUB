// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { compactDecrypt, exportJWK, generateKeyPair } from 'jose';
import { passwordStrengthError, sealCredentials } from './credentials';

describe('credential encryption', () => {
  it('uses authenticated randomized encryption and keeps secrets out of JSON payloads', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RSA-OAEP-256');
    const public_key = { ...await exportJWK(publicKey), kid: 'test-key' };
    const challenge = { public_key, nonce: 'a'.repeat(43), expires_in: 120 };
    const fields = { email: 'reader@example.com', password: 'a long private passphrase' };
    const first = await sealCredentials(fields, 'login', challenge);
    const second = await sealCredentials(fields, 'login', challenge);
    expect(first.credential).not.toBe(second.credential);
    expect(JSON.stringify(first)).not.toContain(fields.password);
    expect(JSON.stringify(first)).not.toContain(fields.email);
    const result = await compactDecrypt(first.credential, privateKey);
    expect(JSON.parse(new TextDecoder().decode(result.plaintext))).toEqual({ fields, nonce: challenge.nonce, purpose: 'login' });
  });

  it('rejects incomplete challenges and enforces the password length policy', async () => {
    await expect(sealCredentials({ password: 'secret' }, 'register', { nonce: '', public_key: {}, expires_in: 0 })).rejects.toThrow();
    expect(passwordStrengthError('weak')).toBeTruthy();
    expect(passwordStrengthError('x'.repeat(129))).toBeTruthy();
    expect(passwordStrengthError('a long memorable passphrase')).toBeNull();
  });
});
