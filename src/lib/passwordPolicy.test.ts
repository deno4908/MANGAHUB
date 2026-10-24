import { expect, it } from 'vitest';
import cases from '../../test-fixtures/password-policy.json';
import { assessPassword, passwordStrengthError } from './passwordPolicy';

it.each(cases)('applies the shared password policy to test value $password', ({ password, accepted }) => {
  expect(assessPassword(password).accepted).toBe(accepted);
  expect(passwordStrengthError(password) === null).toBe(accepted);
});

it('counts Unicode code points and enforces the maximum before strength estimation', () => {
  expect(assessPassword('😀'.repeat(128)).lengthValid).toBe(true);
  expect(assessPassword('😀'.repeat(129)).lengthValid).toBe(false);
  expect(assessPassword('x'.repeat(10000)).accepted).toBe(false);
});
