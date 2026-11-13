'use strict';
function log(db, user, action, entity, entityId, reason, data) {
  db.prepare('INSERT INTO audit_logs(user_id, action, entity, entity_id, reason, data) VALUES (?,?,?,?,?,?)')
    .run(user ? user.id : null, action, entity || null, entityId || null, reason || null, data ? JSON.stringify(data) : null);
}
function forEntity(db, entity, id) {
  return db.prepare(`SELECT a.*, u.full_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.entity = ? AND a.entity_id = ? ORDER BY a.id DESC`).all(entity, id);
}
function recent(db, limit = 200) {
  return db.prepare(`SELECT a.*, u.full_name AS user_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC LIMIT ?`).all(limit);
}
module.exports = { log, forEntity, recent };
