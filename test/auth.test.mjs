import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clearSessionCookie, extractToken, parseCookies, sessionCookie, verifyToken } from '../src/auth.mjs';

test('verifyToken accepts only the exact token', () => {
  assert.equal(verifyToken('abc123', 'abc123'), true);
  assert.equal(verifyToken('abc124', 'abc123'), false);
  assert.equal(verifyToken('abc', 'abc123'), false); // length mismatch must not throw
  assert.equal(verifyToken('', 'abc123'), false);
  assert.equal(verifyToken(undefined, 'abc123'), false);
  assert.equal(verifyToken('abc123', ''), false);
});

test('extractToken reads bearer, query and cookie, in that order', () => {
  const token = 'secret-token';
  assert.equal(extractToken({ headers: { authorization: `Bearer ${token}` }, url: '/?token=fromquery' }), token);
  assert.equal(extractToken({ headers: { cookie: `hmw=${token}` }, url: '/?token=fromquery' }), 'fromquery');
  assert.equal(extractToken({ headers: { cookie: `other=1; hmw=${token}` }, url: '/' }), token);
  assert.equal(extractToken({ headers: {}, url: '/' }), undefined);
});

test('parseCookies survives quoted and spaced values', () => {
  assert.deepEqual(parseCookies('a=1; b=two words; c'), { a: '1', b: 'two words', c: '' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('sessionCookie is HttpOnly, SameSite=Strict and optionally Secure', () => {
  const plain = sessionCookie('tok', { secure: false });
  assert.match(plain, /^hmw=tok;/);
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Strict/);
  assert.match(plain, /Path=\//);
  assert.doesNotMatch(plain, /Secure/);
  assert.match(sessionCookie('tok', { secure: true }), /Secure/);
  assert.match(clearSessionCookie({ secure: true }), /Max-Age=0/);
});

test('token file is created once with owner-only permissions and reused', async () => {
  const { loadOrCreateToken } = await import('../src/config.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmw-token-'));
  const first = loadOrCreateToken(dir);
  const mode = fs.statSync(path.join(dir, 'token')).mode & 0o777;
  const second = loadOrCreateToken(dir);

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.equal(mode, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});
