import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atLeast, hashSecret, newToken, passwordProblem, pinProblem, tokenHash, verifySecret } from '../src/server/auth.ts';

test('secrets are stored as salted scrypt hashes', async () => {
  const a = await hashSecret('2468');
  const b = await hashSecret('2468');
  assert.notEqual(a, b); // different salt each time
  assert.ok(!a.includes('2468'));
  assert.equal(await verifySecret('2468', a), true);
  assert.equal(await verifySecret('2469', a), false);
  assert.equal(await verifySecret('2468', null), false);
  assert.equal(await verifySecret('2468', 'garbage'), false);
});

test('PIN and password rules', () => {
  assert.equal(pinProblem('2468'), undefined);
  assert.equal(pinProblem('802317'), undefined);
  assert.match(pinProblem('12a4')!, /4 to 6 digits/);
  assert.match(pinProblem('1234567')!, /4 to 6 digits/);
  assert.match(pinProblem('7777')!, /repeated/);
  assert.match(pinProblem('1234')!, /run/);
  assert.match(pinProblem('4321')!, /run/);
  assert.match(passwordProblem('short')!, /10 characters/);
  assert.equal(passwordProblem('a long enough one'), undefined);
});

test('tokens are random and only their hash is kept', () => {
  const { token, hash } = newToken();
  assert.equal(hash, tokenHash(token));
  assert.notEqual(newToken().token, token);
  assert.equal(token.length, 43);
});

test('role levels', () => {
  assert.equal(atLeast('owner', 'manager'), true);
  assert.equal(atLeast('chef', 'manager'), false);
  assert.equal(atLeast('manager', 'manager'), true);
});
