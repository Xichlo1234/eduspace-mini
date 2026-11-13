'use strict';
const crypto = require('crypto');
const OPTS = { N: 16384, r: 8, p: 1 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 64, OPTS);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, keyHex] = stored.split('$');
  const key = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 64, OPTS);
  const ref = Buffer.from(keyHex, 'hex');
  return ref.length === key.length && crypto.timingSafeEqual(ref, key);
}
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Mật khẩu cần ít nhất 8 ký tự';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Mật khẩu cần có cả chữ và số';
  return null;
}
function randomToken(bytes = 24) { return crypto.randomBytes(bytes).toString('base64url'); }
module.exports = { hashPassword, verifyPassword, validatePassword, randomToken };
