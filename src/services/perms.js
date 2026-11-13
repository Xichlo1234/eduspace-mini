'use strict';
// Kiểm tra quyền ở backend. Mọi route/service gọi các hàm này, không dựa vào việc ẩn nút.
const { AppError } = require('../lib/errors');

const isOwner = (u) => !!u && u.role === 'owner';
const isStaff = (u) => !!u && u.role === 'staff';
const isTeacher = (u) => !!u && u.role === 'teacher';
const isOperator = (u) => isOwner(u) || isStaff(u); // chủ hoặc nhân viên vận hành

const can = {
  manageStudents: isOperator,
  manageClasses: isOperator,
  collectMoney: isOperator,
  viewStudentFinance: isOperator,
  spendMoney: (u) => isOwner(u) || (isStaff(u) && !!u.perm_expense),
  adjustMoney: (u) => isOwner(u) || (isStaff(u) && !!u.perm_void), // miễn giảm, hủy/điều chỉnh giao dịch
  viewReports: (u) => isOwner(u) || (isStaff(u) && !!u.perm_reports),
  manageSettings: isOwner,
  manageUsers: isOwner,
  backup: isOwner,
  payTeachers: isOwner, // chủ trung tâm xác nhận chi tiền dạy
};

function require_(u, perm, msg) {
  if (!can[perm](u)) throw new AppError(msg || 'Bạn không có quyền thực hiện thao tác này', 403);
}

/** Giáo viên chỉ truy cập lớp được phân công (GV chính) hoặc buổi mình dạy thay */
function teacherCanAccessClass(db, u, classId) {
  if (isOperator(u)) return true;
  if (!isTeacher(u) || !u.teacher_id) return false;
  const c = db.prepare('SELECT teacher_id FROM classes WHERE id = ?').get(classId);
  if (!c) return false;
  if (c.teacher_id === u.teacher_id) return true;
  return !!db.prepare('SELECT 1 FROM class_sessions WHERE class_id = ? AND teacher_id = ? LIMIT 1').get(classId, u.teacher_id);
}
function canAccessSession(db, u, sessionId) {
  if (isOperator(u)) return true;
  if (!isTeacher(u) || !u.teacher_id) return false;
  const s = db.prepare('SELECT s.teacher_id, c.teacher_id AS main FROM class_sessions s JOIN classes c ON c.id = s.class_id WHERE s.id = ?').get(sessionId);
  return !!s && (s.teacher_id === u.teacher_id || s.main === u.teacher_id);
}
function assertClassAccess(db, u, classId) {
  if (!teacherCanAccessClass(db, u, classId)) throw new AppError('Bạn không được phân công lớp này', 403);
}
function assertSessionAccess(db, u, sessionId) {
  if (!canAccessSession(db, u, sessionId)) throw new AppError('Bạn không được phân công buổi học này', 403);
}
/** Giáo viên xem được học sinh nếu học sinh từng học lớp mình phụ trách */
function canAccessStudent(db, u, studentId) {
  if (isOperator(u)) return true;
  if (!isTeacher(u) || !u.teacher_id) return false;
  return !!db.prepare(`SELECT 1 FROM enrollments e JOIN classes c ON c.id = e.class_id
    WHERE e.student_id = ? AND (c.teacher_id = ? OR EXISTS (SELECT 1 FROM class_sessions s WHERE s.class_id = c.id AND s.teacher_id = ?)) LIMIT 1`)
    .get(studentId, u.teacher_id, u.teacher_id);
}

module.exports = { isOwner, isStaff, isTeacher, isOperator, can, require: require_, teacherCanAccessClass, canAccessSession, assertClassAccess, assertSessionAccess, canAccessStudent };
