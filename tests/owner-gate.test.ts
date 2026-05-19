import { describe, expect, test } from 'vitest';
import { checkOwnerActive } from '../src/owner-gate.js';

describe('checkOwnerActive', () => {
  test('legacy groups without owner info pass (backward compat)', () => {
    expect(checkOwnerActive(null)).toEqual({ allowed: true });
    expect(checkOwnerActive(undefined)).toEqual({ allowed: true });
  });

  test('active owner is allowed', () => {
    expect(checkOwnerActive({ status: 'active' })).toEqual({ allowed: true });
  });

  test('disabled owner is blocked', () => {
    expect(checkOwnerActive({ status: 'disabled' })).toEqual({
      allowed: false,
      reason: 'inactive_owner',
      status: 'disabled',
    });
  });

  test('deleted owner is blocked', () => {
    expect(checkOwnerActive({ status: 'deleted' })).toEqual({
      allowed: false,
      reason: 'inactive_owner',
      status: 'deleted',
    });
  });

  test('unknown / future status values are blocked (fail-safe default)', () => {
    expect(checkOwnerActive({ status: 'pending_review' })).toEqual({
      allowed: false,
      reason: 'inactive_owner',
      status: 'pending_review',
    });
    expect(checkOwnerActive({ status: '' })).toEqual({
      allowed: false,
      reason: 'inactive_owner',
      status: '',
    });
  });
});
