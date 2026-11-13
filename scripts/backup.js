#!/usr/bin/env node
'use strict';
// Sao lưu thủ công từ dòng lệnh: node scripts/backup.js [thư-mục-đích]
const path = require('path');
const { openDb } = require('../src/db');
const backup = require('../src/services/backup');
const file = path.resolve(process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'app.db'));
const db = openDb(file);
const target = path.join(process.argv[2] || backup.backupDir(file), `manual-${backup.stamp()}.db`);
backup.backupTo(db, target).then(() => { console.log('Đã sao lưu:', target); db.close(); });
