'use strict';
// Kiểm thử qua HTTP: đăng nhập, phân quyền backend, chống bấm trùng, và duyệt toàn bộ trang với dữ liệu mẫu.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const request = require('supertest');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edu-test-'));
const file = path.join(dir, 'demo-test.db');
execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed-demo.js')], { env: { ...process.env, DEMO_FILE: file }, stdio: 'pipe' });
const state = { db: openDb(file), demo: true };
const app = createApp(state);

async function login(username, password = 'Demo2026') {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const res = await agent.post('/login').type('form').send({ _csrf: csrf, username, password, next: '/' });
  assert.equal(res.status, 302, `đăng nhập ${username}`);
  const home = await agent.get('/');
  const token = home.text.match(/name="_csrf" value="([^"]+)"/)[1];
  return { agent, csrf: token };
}

test('Chưa đăng nhập bị chuyển tới trang đăng nhập; sai mật khẩu bị từ chối', async () => {
  const r = await request(app).get('/reports');
  assert.equal(r.status, 302); assert.match(r.headers.location, /\/login/);
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const bad = await agent.post('/login').type('form').send({ _csrf: csrf, username: 'chu.demo', password: 'sai-mat-khau1' });
  assert.equal(bad.status, 401);
});

test('Giáo viên không truy cập được báo cáo thu chi, học phí, cài đặt (kiểm tra ở backend)', async () => {
  const { agent, csrf } = await login('gv.lan');
  for (const url of ['/reports', '/reports/export/summary.xlsx', '/finance', '/cashbook', '/receipts', '/settings', '/settings/users', '/settings/backup', '/teachers/pay', '/billing/bulk', '/students']) {
    const r = await agent.get(url);
    assert.equal(r.status, 403, `GV phải bị chặn ở ${url}`);
  }
  const post = await agent.post('/cashbook').type('form').send({ _csrf: csrf, direction: 'out', category: 'rent', amount: '1000000' });
  assert.equal(post.status, 403);
  // lớp không được phân công
  const other = state.db.prepare("SELECT s.id FROM class_sessions s JOIN classes c ON c.id = s.class_id JOIN teachers t ON t.id = c.teacher_id WHERE t.full_name <> 'Trần Thị Lan' AND s.teacher_id <> (SELECT id FROM teachers WHERE full_name = 'Trần Thị Lan') LIMIT 1").get();
  assert.equal((await agent.get(`/sessions/${other.id}`)).status, 403);
  const mine = state.db.prepare("SELECT s.id FROM class_sessions s JOIN classes c ON c.id = s.class_id WHERE c.teacher_id = (SELECT id FROM teachers WHERE full_name = 'Trần Thị Lan') LIMIT 1").get();
  assert.equal((await agent.get(`/sessions/${mine.id}`)).status, 200);
  assert.equal((await agent.get('/')).status, 200);
  assert.equal((await agent.get('/schedule')).status, 200);
});

test('Nhân viên không có quyền báo cáo/chi tiền bị chặn; POST thiếu CSRF bị chặn', async () => {
  const { agent, csrf } = await login('nhanvien.demo');
  assert.equal((await agent.get('/reports')).status, 403);
  assert.equal((await agent.get('/students')).status, 200);
  const r = await agent.post('/cashbook').type('form').send({ _csrf: csrf, direction: 'out', category: 'rent', amount: '1000000' });
  assert.equal(r.status, 403);
  const noCsrf = await agent.post('/cashbook').type('form').send({ direction: 'in', category: 'other_in', amount: '1000' });
  assert.equal(noCsrf.status, 403);
});

test('Bấm “Xác nhận thu tiền” hai lần chỉ tạo một phiếu thu', async () => {
  const { agent, csrf } = await login('chu.demo');
  const inv = state.db.prepare(`SELECT i.id FROM invoices i WHERE i.status = 'active' AND i.amount > COALESCE((SELECT SUM(amount) FROM allocations a WHERE a.invoice_id = i.id AND a.status='valid'),0) LIMIT 1`).get();
  assert.ok(inv, 'cần một khoản còn nợ trong dữ liệu mẫu');
  const form = await agent.get(`/payments/new?invoice_id=${inv.id}`);
  const key = form.text.match(/name="idempotency_key" value="([^"]+)"/)[1];
  const before = state.db.prepare('SELECT COUNT(*) n FROM receipts').get().n;
  const body = { _csrf: csrf, idempotency_key: key, invoice_id: inv.id, amount: '10000', method: 'cash', paid_date: '' };
  const [a, b] = await Promise.all([agent.post('/payments').type('form').send(body), agent.post('/payments').type('form').send(body)]);
  assert.equal(a.status, 303); assert.equal(b.status, 303);
  assert.equal(a.headers.location, b.headers.location);
  assert.equal(state.db.prepare('SELECT COUNT(*) n FROM receipts').get().n, before + 1);
});

test('Duyệt toàn bộ trang bằng tài khoản chủ trung tâm: không có lỗi hiển thị', async () => {
  const { agent } = await login('chu.demo');
  const seen = new Set(); const queue = ['/'];
  const failures = [];
  while (queue.length && seen.size < 400) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const r = await agent.get(url);
    if (r.status !== 200) { failures.push(`${url} → ${r.status}`); continue; }
    if (!/html/.test(r.headers['content-type'] || '')) continue;
    for (const m of r.text.matchAll(/href="(\/[^"#]*)"/g)) {
      let u = m[1].replace(/&amp;/g, '&');
      if (u.startsWith('/public') || u.startsWith('/logout') || u.includes('download/')) continue;
      // giới hạn số trang chi tiết cùng loại
      const kind = u.replace(/\d+/g, 'N');
      if ([...seen].filter((s) => s.replace(/\d+/g, 'N') === kind).length >= 4) continue;
      if (!seen.has(u)) queue.push(u);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(seen.size > 40, `đã duyệt ${seen.size} trang`);
});

test.after(() => { state.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
