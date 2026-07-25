import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest } from '../src/validateRequest';

describe('validateRequest', () => {
  it('returns trimmed text for valid input', () => {
    assert.equal(validateRequest('  hello world  '), 'hello world');
  });

  it('throws for empty string', () => {
    assert.throws(() => validateRequest(''), /cannot be empty/);
  });

  it('throws for whitespace-only string', () => {
    assert.throws(() => validateRequest('   \t\n  '), /cannot be empty/);
  });

  it('throws for backslash-only input', () => {
    assert.throws(() => validateRequest('\\\\'), /cannot consist only of backslashes/);
  });

  it('throws for null or undefined', () => {
    assert.throws(() => validateRequest(null), /No request was provided/);
    assert.throws(() => validateRequest(undefined), /No request was provided/);
  });
});
