'use strict';
// Chạy lại toàn bộ kiểm thử HTTP với giao diện đã biên dịch sẵn như trên Cloudflare Workers (không dùng with/new Function lúc chạy).
const os = require('os');
const fs = require('fs');
const path = require('path');
const { build } = require('../scripts/build-cf');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'edu-cfviews-'));
build(out);
globalThis.__EDU_VIEWS__ = require(path.join(out, 'views.generated.cjs'));
require('./http.test.js');
