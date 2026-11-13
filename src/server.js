'use strict';
const path = require('path');
const { openDb } = require('./db');
const { createApp } = require('./app');
const classes = require('./services/classes');
const backup = require('./services/backup');

const file = path.resolve(process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'app.db'));
const demo = /demo/i.test(path.basename(file)) || process.env.DEMO === '1';
const state = { db: openDb(file), demo };
const port = Number(process.env.PORT || 3000);

function daily() {
  try { classes.extendAll(state.db); } catch (e) { console.error('Gia hạn lịch lỗi:', e.message); }
  backup.autoBackup(state.db).catch((e) => console.error('Sao lưu tự động lỗi:', e.message));
}
daily();
setInterval(daily, 6 * 3600 * 1000).unref();

const app = createApp(state);
const server = app.listen(port, process.env.HOST || '0.0.0.0', () => {
  console.log(`Eduspace Mini đang chạy: http://localhost:${port}`);
  console.log(`CSDL: ${file}${demo ? '  (DỮ LIỆU MẪU)' : ''}`);
});
function shutdown() { server.close(() => { try { state.db.close(); } catch (e) { /* */ } process.exit(0); }); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
