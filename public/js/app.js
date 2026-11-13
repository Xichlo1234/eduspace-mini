// Tiện ích giao diện nhỏ – không dùng thư viện ngoài
(function () {
  // Chống bấm nhiều lần: khóa nút gửi sau lần bấm đầu (phía máy chủ vẫn chống trùng bằng idempotency key)
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.dataset.confirm && !window.confirm(f.dataset.confirm)) { e.preventDefault(); return; }
    if (f.dataset.submitting) { e.preventDefault(); return; }
    f.dataset.submitting = '1';
    var btns = f.querySelectorAll('button[type=submit], button:not([type])');
    var clicked = e.submitter;
    setTimeout(function () { btns.forEach(function (b) { b.disabled = true; if (b === clicked) b.textContent = 'Đang xử lý…'; }); }, 0);
  });

  // Menu điện thoại
  var tgl = document.getElementById('nav-toggle');
  if (tgl) tgl.addEventListener('click', function () { document.body.classList.toggle('nav-open'); });

  // Ô nhập tiền: hiển thị dấu chấm ngăn cách
  document.querySelectorAll('input[data-money]').forEach(function (i) {
    function fmt() {
      var raw = i.value.replace(/[^\d]/g, '');
      if (!raw) return;
      i.value = raw.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    }
    i.addEventListener('blur', fmt); fmt();
  });

  // Điểm danh: đánh dấu tất cả có mặt
  var allBtn = document.getElementById('mark-all-present');
  if (allBtn) allBtn.addEventListener('click', function () {
    document.querySelectorAll('input[type=radio][value=present]').forEach(function (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
    var note = document.getElementById('unsaved'); if (note) note.hidden = false;
  });
  document.querySelectorAll('form.attendance input, form.attendance textarea').forEach(function (el) {
    el.addEventListener('change', function () { var n = document.getElementById('unsaved'); if (n) n.hidden = false; });
  });
  window.addEventListener('beforeunload', function (e) {
    var n = document.getElementById('unsaved');
    var f = document.querySelector('form.attendance');
    if (n && !n.hidden && f && !f.dataset.submitting) { e.preventDefault(); e.returnValue = ''; }
  });

  // Thêm dòng lịch học
  var addSlot = document.getElementById('add-slot');
  if (addSlot) addSlot.addEventListener('click', function () {
    var wrap = document.getElementById('slots');
    var rows = wrap.querySelectorAll('.slot-row');
    var last = rows[rows.length - 1];
    var clone = last.cloneNode(true);
    var idx = rows.length;
    clone.querySelectorAll('select, input').forEach(function (el) { el.name = el.name.replace(/slots\[\d+\]/, 'slots[' + idx + ']'); if (el.tagName === 'SELECT') el.value = ''; });
    wrap.appendChild(clone);
  });
  document.addEventListener('click', function (e) {
    if (e.target.classList.contains('rm-slot')) {
      var rows = document.querySelectorAll('.slot-row');
      if (rows.length > 1) e.target.closest('.slot-row').remove();
    }
    if (e.target.dataset.copy) {
      var el = document.getElementById(e.target.dataset.copy);
      var text = el.value || el.textContent;
      var done = function () { e.target.textContent = 'Đã sao chép ✓'; setTimeout(function () { e.target.textContent = 'Sao chép nội dung'; }, 2000); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done);
      else { el.select && el.select(); document.execCommand('copy'); done(); }
    }
  });

  // Hiện giải thích hình thức học phí theo lựa chọn
  var ft = document.getElementById('fee_type');
  function syncFee() {
    if (!ft) return;
    document.querySelectorAll('[data-fee]').forEach(function (el) { el.hidden = el.dataset.fee.split(' ').indexOf(ft.value) < 0; });
  }
  if (ft) { ft.addEventListener('change', syncFee); syncFee(); }
  var bt = document.getElementById('billing_timing');
  function syncTiming() {
    if (!bt) return;
    document.querySelectorAll('[data-timing]').forEach(function (el) {
      var hideByFee = el.dataset.fee && ft && el.dataset.fee.split(' ').indexOf(ft.value) < 0;
      el.hidden = hideByFee || el.dataset.timing !== bt.value;
    });
  }
  if (bt) { bt.addEventListener('change', syncTiming); if (ft) ft.addEventListener('change', syncTiming); syncTiming(); }

  // Chọn chế độ xếp lớp
  function syncMode() {
    var m = document.querySelector('input[name=mode]:checked') || document.querySelector('input[type=hidden][name=mode]');
    if (!m) return;
    document.querySelectorAll('[data-mode]').forEach(function (el) { el.hidden = el.dataset.mode !== m.value; });
  }
  document.querySelectorAll('input[name=mode]').forEach(function (r) { r.addEventListener('change', syncMode); });
  syncMode();

  // Chọn tất cả (tạo học phí hàng loạt)
  var chkAll = document.getElementById('check-all');
  if (chkAll) chkAll.addEventListener('change', function () { document.querySelectorAll('input[name=keys]').forEach(function (c) { c.checked = chkAll.checked; }); });
})();
