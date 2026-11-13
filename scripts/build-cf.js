#!/usr/bin/env node
'use strict';
/**
 * Chuẩn bị bản chạy trên Cloudflare Workers (wrangler tự gọi trước khi dev/deploy):
 *  1. Biên dịch sẵn mọi giao diện EJS thành hàm JS (Workers không cho phép new Function, và ESM luôn ở chế độ strict
 *     nên không dùng được `with`): biến tự do trong mẫu được lấy từ `locals` bằng phân tích phạm vi (eslint-scope).
 *  2. Chép thư mục public/ sang cf/assets/public/ để Cloudflare phục vụ như file tĩnh.
 * Dùng: node scripts/build-cf.js [thư-mục-ra]   (mặc định cf/)
 */
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const espree = require('espree');
const eslintScope = require('eslint-scope');

const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'src', 'views');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'cf'));

function listViews(dir, base = '') {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f); const rel = base ? `${base}/${f}` : f;
    if (fs.statSync(full).isDirectory()) out.push(...listViews(full, rel));
    else if (f.endsWith('.ejs')) out.push(rel.replace(/\.ejs$/, ''));
  }
  return out.sort();
}

const PARAMS = new Set(['locals', 'escapeFn', 'include', 'rethrow']);
function freeNames(fnSource) {
  const ast = espree.parse(`(${fnSource})`, { ecmaVersion: 2022, sourceType: 'script', range: true });
  const sm = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'script' });
  const names = new Set();
  for (const ref of sm.globalScope.through) names.add(ref.identifier.name);
  return [...names].filter((n) => !PARAMS.has(n) && !(n in globalThis) && n !== 'undefined');
}

function compile(name) {
  const file = path.join(VIEWS, `${name}.ejs`);
  const src = fs.readFileSync(file, 'utf8');
  const t = new ejs.Template(src, { client: true, strict: true, _with: false, localsName: 'locals', compileDebug: false, filename: file });
  t.compile();
  const body = t.source; // thân hàm do EJS sinh ra (chưa bọc)
  const names = freeNames(`function (locals, escapeFn, include, rethrow) {${body}\n}`);
  const decl = names.length ? `\n  var __l = locals || {}; var ${names.map((n) => `${n} = __l[${JSON.stringify(n)}]`).join(', ')};` : '';
  return `function (locals, escapeFn, include, rethrow) {${decl}\n${body}\n}`;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f); const d = path.join(dst, f);
    if (fs.statSync(s).isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function build(outDir = OUT) {
  const names = listViews(VIEWS);
  const parts = names.map((n) => `  ${JSON.stringify(n)}: ${compile(n)}`);
  fs.mkdirSync(outDir, { recursive: true });
  const body = `/* Tự sinh bởi scripts/build-cf.js – không sửa tay */\n'use strict';\nconst VIEWS = {\n${parts.join(',\n')}\n};\n`;
  fs.writeFileSync(path.join(outDir, 'views.generated.js'), `${body}export default VIEWS;\n`);
  fs.writeFileSync(path.join(outDir, 'views.generated.cjs'), `${body}module.exports = VIEWS;\n`);
  fs.rmSync(path.join(outDir, 'assets'), { recursive: true, force: true });
  copyDir(path.join(ROOT, 'public'), path.join(outDir, 'assets', 'public'));
  return names.length;
}

if (require.main === module) {
  const n = build();
  console.log(`Đã biên dịch ${n} giao diện và chép file tĩnh vào ${path.relative(ROOT, OUT) || '.'}`);
}
module.exports = { build };
