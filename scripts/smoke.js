#!/usr/bin/env node
'use strict';
/**
 * Kiểm thử nhanh một bản đang chạy (ví dụ `wrangler dev` hoặc bản mới tạo trên Cloudflare, CSDL còn TRỐNG):
 *   node scripts/smoke.js http://127.0.0.1:8787
 * Tạo tài khoản chủ → lớp → học sinh → đặt cọc → xếp lớp → điểm danh → lập học phí cuối kỳ → thu tiền → in phiếu
 * → xuất Excel → nhập Excel → logo → sao lưu/khôi phục JSON → duyệt toàn bộ trang. KHÔNG chạy vào hệ thống đã có dữ liệu thật.
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const jar = new Map();
let csrf = null;
const ok = (c, m) => { if (!c) { console.error('✘', m); process.exitCode = 1; throw new Error(m); } console.log('✔', m); };

async function req(method, url, { form, multipart, follow = false } = {}) {
  const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
  let body;
  if (form) { body = new URLSearchParams(form).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
  if (multipart) body = multipart;
  const r = await fetch(BASE + url, { method, headers, body, redirect: 'manual' });
  for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : []) {
    const [kv] = c.split(';'); const i = kv.indexOf('=');
    const k = kv.slice(0, i); const v = kv.slice(i + 1);
    if (/expires=Thu, 01 Jan 1970/i.test(c) || v === '') jar.delete(k); else jar.set(k, v);
  }
  const ct = r.headers.get('content-type') || '';
  const text = /html|json|text/.test(ct) ? await r.text() : (await r.arrayBuffer(), '');
  const m = text.match(/name="_csrf" value="([^"]+)"/); if (m && jar.has('sid')) csrf = m[1];
  if (follow && r.status >= 300 && r.status < 400) return req('GET', r.headers.get('location'), { follow: true });
  return { status: r.status, text, location: r.headers.get('location'), ct };
}
const post = (url, form) => req('POST', url, { form: { _csrf: csrf, ...form } });

(async () => {
  const s0 = await req('GET', '/setup');
  ok(s0.status === 200 && /Chào mừng/.test(s0.text), 'Trang thiết lập lần đầu (CSDL trống)');
  const pc = s0.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const s1 = await req('POST', '/setup', { form: { _csrf: pc, center_name: 'Anh ngữ Thử nghiệm', full_name: 'Chủ TT', username: 'chu.thu', password: 'ThuNghiem2026', password2: 'ThuNghiem2026' } });
  ok(s1.status === 302 && jar.has('sid'), 'Tạo tài khoản chủ trung tâm & đăng nhập');
  const home = await req('GET', '/'); ok(home.status === 200 && /Bắt đầu nhanh/.test(home.text), 'Trang tổng quan');

  ok((await post('/teachers', { full_name: 'Cô Lan', default_rate: '200.000' })).status === 303, 'Thêm giáo viên');
  const tid = (await req('GET', '/teachers')).text.match(/href="\/teachers\/(\d+)"/)[1];
  const c = await post('/classes', { name: 'Starters tối 3-5', teacher_id: tid, start_date: '01/09/2026', fee_type: 'monthly', fee_amount: '800.000', billing_timing: 'postpaid',
    prorate_first_month: '1', excused_absence_charged: '1', unexcused_absence_charged: '1', 'slots[0][weekday]': '2', 'slots[0][start_time]': '18:00', 'slots[0][end_time]': '19:30',
    'slots[1][weekday]': '4', 'slots[1][start_time]': '18:00', 'slots[1][end_time]': '19:30' });
  ok(c.status === 303, 'Tạo lớp thu cuối kỳ + sinh lịch');
  const cid = c.location.match(/\/classes\/(\d+)/)[1];
  ok((await post('/settings/holidays', { date: '01/09/2026', name: 'Nghỉ bù' })).status === 303, 'Thêm ngày nghỉ');

  const st = await post('/students', { full_name: 'Nguyễn Văn Thử', parent_name: 'Nguyễn Văn Cha', parent_phone: '0901234567', then: 'view' });
  ok(st.status === 303, 'Thêm học sinh');
  const sid = st.location.match(/\/students\/(\d+)/)[1];
  const payForm = await req('GET', `/payments/new?student_id=${sid}&deposit=1`);
  const key = payForm.text.match(/name="idempotency_key" value="([^"]+)"/)[1];
  const dep = await post('/payments', { idempotency_key: key, student_id: sid, amount: '300.000', method: 'cash', paid_date: '15/09/2026' });
  const dep2 = await post('/payments', { idempotency_key: key, student_id: sid, amount: '300.000', method: 'cash', paid_date: '15/09/2026' });
  ok(dep.status === 303 && dep.location === dep2.location, 'Đặt cọc – bấm 2 lần chỉ 1 phiếu');

  const en = await post(`/students/${sid}/enroll`, { mode: 'active', class_id: cid, start_date: '17/09/2026', action: 'confirm' });
  ok(en.status === 303, 'Xếp lớp (thu cuối kỳ, chưa lập học phí)');
  const cls = await req('GET', `/classes/${cid}?all=1`);
  const sess = [...cls.text.matchAll(/href="\/sessions\/(\d+)"/g)].map((m) => m[1]);
  const att = await req('GET', `/sessions/${sess[4]}`);
  ok(att.status === 200 && /Điểm danh/.test(att.text), 'Mở trang điểm danh');
  ok((await post(`/sessions/${sess[4]}/attendance`, { 'items[0][student_id]': sid, 'items[0][status]': 'present', 'items[0][score]': '9', complete: '1' })).status === 303, 'Lưu điểm danh');

  const bulk = await req('GET', '/billing/bulk?ym=2026-10&ym_post=2026-09');
  const keys = [...bulk.text.matchAll(/name="keys" value="([^"]+)"/g)].map((m) => m[1]);
  ok(keys.length === 1 && /400\.000 đ/.test(bulk.text), 'Xem trước học phí cuối kỳ tháng 9: 400.000đ');
  const bp = new URLSearchParams({ _csrf: csrf, ym: '2026-10', ym_post: '2026-09', apply_credit: '1' }); keys.forEach((k) => bp.append('keys', k));
  ok((await req('POST', '/billing/bulk', { form: bp })).status === 303, 'Lập học phí hàng loạt (trừ đặt cọc)');
  const fin = await req('GET', '/finance');
  const invId = fin.text.match(/\/payments\/new\?invoice_id=(\d+)/)[1];
  ok(/100\.000 đ/.test(fin.text), 'Công nợ còn 100.000đ sau khi trừ cọc');
  const pf = await req('GET', `/payments/new?invoice_id=${invId}`);
  const k2 = pf.text.match(/name="idempotency_key" value="([^"]+)"/)[1];
  const pay = await post('/payments', { idempotency_key: k2, invoice_id: invId, amount: '100.000', method: 'transfer', paid_date: '' });
  ok(pay.status === 303, 'Thu nợ');
  const pr = await req('GET', `${pay.location}?print=1`);
  ok(pr.status === 200 && /PHIẾU THU/.test(pr.text), 'In phiếu thu');

  for (const u of ['/reports/export/summary.xlsx', '/reports/export/receipts.xlsx', '/students/export.xlsx', '/students/template.xlsx', '/teachers/pay.xlsx']) {
    const x = await req('GET', u); ok(x.status === 200 && /spreadsheet|xlsx|octet/.test(x.ct), `Xuất Excel ${u}`);
  }
  const tpl = await fetch(BASE + '/students/template.xlsx', { headers: { cookie: [...jar].map(([a, b]) => `${a}=${b}`).join('; ') } }).then((r) => r.arrayBuffer());
  const fd = new FormData(); fd.append('_csrf', csrf); fd.append('file', new Blob([tpl]), 'mau.xlsx');
  const imp = await req('POST', '/students/import', { multipart: fd });
  ok(imp.status === 200 && /Xem trước/.test(imp.text), 'Nhập Excel: xem trước');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fl = new FormData(); fl.append('_csrf', csrf); fl.append('center_name', 'Anh ngữ Thử nghiệm'); fl.append('logo', new Blob([png], { type: 'image/png' }), 'logo.png');
  ok((await req('POST', '/settings', { multipart: fl })).status === 303 && (await req('GET', '/logo')).status === 200, 'Tải logo lên');

  const exp = await fetch(BASE + '/settings/backup/export.json', { headers: { cookie: [...jar].map(([a, b]) => `${a}=${b}`).join('; ') } }).then((r) => r.text());
  const data = JSON.parse(exp);
  ok(data.app === 'eduspace-mini' && data.tables.receipts.length === 2, 'Sao lưu JSON');
  const fr = new FormData(); fr.append('_csrf', csrf); fr.append('confirm', 'KHOI PHUC'); fr.append('file', new Blob([exp], { type: 'application/json' }), 'b.json');
  const rs = await req('POST', '/settings/backup/import', { multipart: fr });
  ok(rs.status === 303 && /login/.test(rs.location), 'Khôi phục JSON');
  const lg = await req('GET', '/login'); const pc2 = lg.text.match(/name="_csrf" value="([^"]+)"/)[1];
  ok((await req('POST', '/login', { form: { _csrf: pc2, username: 'chu.thu', password: 'ThuNghiem2026', next: '/' } })).status === 302, 'Đăng nhập lại sau khôi phục');

  const seen = new Set(); const queue = ['/']; const bad = [];
  while (queue.length && seen.size < 250) {
    const u = queue.shift(); if (seen.has(u)) continue; seen.add(u);
    const r = await req('GET', u);
    if (r.status !== 200) { bad.push(`${u} → ${r.status}`); continue; }
    for (const m of r.text.matchAll(/href="(\/[^"#]*)"/g)) {
      const v = m[1].replace(/&amp;/g, '&');
      if (/^\/(public|logout)|download|export|\.xlsx|print=1/.test(v)) continue;
      const kind = v.replace(/\d+/g, 'N'); if ([...seen].filter((x) => x.replace(/\d+/g, 'N') === kind).length >= 3) continue;
      if (!seen.has(v)) queue.push(v);
    }
  }
  ok(!bad.length, `Duyệt ${seen.size} trang không lỗi${bad.length ? ': ' + bad.join(', ') : ''}`);
  console.log('\nHOÀN TẤT – mọi bước đều đạt');
})().catch((e) => { console.error(e.message); process.exit(1); });
