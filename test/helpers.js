'use strict';
const { openDb } = require('../src/db');
const users = require('../src/services/users');
const catalog = require('../src/services/catalog');

function setup() {
  const db = openDb(':memory:');
  const ownerId = users.createOwner(db, { username: 'chu', full_name: 'Chủ TT', password: 'MatKhau123' });
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(ownerId);
  // các kiểm thử nghiệm thu gốc dùng thu đầu kỳ; kiểm thử thu cuối kỳ khai báo riêng
  require('../src/services/settings').set(db, 'default_billing_timing', 'prepaid');
  const t1 = catalog.saveTeacher(db, owner, { full_name: 'GV An', default_rate: '200000' });
  const t2 = catalog.saveTeacher(db, owner, { full_name: 'GV Bình', default_rate: '250000' });
  const room = catalog.saveRoom(db, owner, { name: 'P101', capacity: 20 });
  const room2 = catalog.saveRoom(db, owner, { name: 'P102', capacity: 20 });
  const subj = catalog.saveSubject(db, owner, { name: 'Tiếng Anh' });
  return { db, owner, t1, t2, room, room2, subj };
}
function userOf(db, id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
module.exports = { setup, userOf };
