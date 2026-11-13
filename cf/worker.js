/**
 * Điểm vào trên Cloudflare Workers.
 * - Worker nhận mọi yêu cầu và chuyển vào MỘT Durable Object duy nhất ("main") – nơi chạy ứng dụng Express
 *   và giữ CSDL SQLite (đồng bộ, nhất quán, phù hợp trung tâm < 200 học sinh).
 * - File tĩnh (/public/...) do Cloudflare phục vụ trực tiếp từ cf/assets (không tốn lượt chạy Worker).
 */
import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import http from 'node:http';
import views from './views.generated.js';
import schemaSql from '../src/schema.sql';
import DoDatabase from '../src/sqlite-do.js';
import { initDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import classes from '../src/services/classes.js';

globalThis.__EDU_VIEWS__ = views;
const state = { db: null, demo: false, cloudflare: true };
const app = createApp(state);
http.createServer(app).listen(8080);
const handler = httpServerHandler({ port: 8080 });

export class EduspaceApp extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      state.db = initDb(new DoDatabase(ctx.storage), schemaSql);
      try { classes.extendAll(state.db); } catch (e) { console.error('Gia hạn lịch lỗi', e); }
    });
  }
  async fetch(request) { return handler.fetch(request, this.env, this.ctx); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    const ip = request.headers.get('cf-connecting-ip');
    if (ip) headers.set('x-forwarded-for', ip);
    const stub = env.APP.get(env.APP.idFromName('main'));
    return stub.fetch(new Request(request, { headers }));
  },
};
