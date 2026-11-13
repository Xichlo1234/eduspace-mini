#!/usr/bin/env node
'use strict';
// Tạo dữ liệu mẫu rồi chạy ứng dụng ở cổng 3001 – dùng được trên Windows, macOS, Linux.
const path = require('path');
const { execFileSync } = require('child_process');

execFileSync(process.execPath, [path.join(__dirname, 'seed-demo.js')], { stdio: 'inherit' });
process.env.DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'demo.db');
process.env.PORT = process.env.PORT || '3001';
require('../src/server');
