(function () {
  'use strict';
  const API_URL = (window.SO_DAT_BAN || {}).API_URL || '';
  const POLL_MS = 30000;
  const SOURCES = ['Điện thoại', 'Zalo', 'Facebook', 'Website', 'Tại quán', 'Khác'];
  const QUICK_TIMES = ['11:00', '12:00', '17:30', '18:00', '18:30', '19:00', '19:30'];
  const STATUS_CLASS = { 'Mới': '', 'Đã xác nhận': 's-ok', 'Đã đến': 's-done', 'Không đến': 's-off', 'Đã huỷ': 's-off' };
  const NO_AREA = 'Không yêu cầu';
  const AREAS = ['Trong nhà', 'Ngoài trời', NO_AREA];
  const TAGS = [
    ['in', 'Trong nhà', b => b.area === 'Trong nhà'],
    ['out', 'Ngoài trời', b => b.area === 'Ngoài trời'],
    ['view', 'Sát view', b => b.view],
    ['decor', 'Decor', b => b.decor],
  ];
  const ACTIVE = new Set(['Mới', 'Đã xác nhận', 'Đã đến']);
  const CLASH_MINUTES = 120;
  const MAX_IMAGES = 5;
  const DECOR_ITEMS = ['Đặt bánh', 'Đặt hoa', 'Nhận bánh giùm', 'Nhận hoa giùm'];
  const IMAGE_SIDE = 1280;
  const DOW = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  const DOW_FULL = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
  const today = () => ymd(new Date());
  const ddmm = s => { const d = parse(s); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
  const dayLabel = s => `${DOW[parse(s).getDay()]} ${ddmm(s)}`;
  const minutes = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const money = n => `${Number(n).toLocaleString('vi-VN')}đ`;
  const fold = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
  const byTime = (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time);
  const decorOf = b => String(b.decorItems || '').split(',').filter(Boolean);
  const tagsOf = b => [b.area === NO_AREA ? 'Không yêu cầu chỗ' : b.area, b.view && 'Sát view', b.decor && 'Decor', ...decorOf(b)].filter(Boolean);
  const imgs = b => b.images || [];
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* trình duyệt chặn lưu */ } },
  };

  let token = store.get('sdb_token');
  let me = store.get('sdb_name') || '';
  let role = store.get('sdb_role') || 'edit';
  const canEdit = () => role === 'edit';
  let rows = [];
  let rev = '';
  let date = today();
  let query = '';
  let tag = '';
  let online = true;
  let editing = null;
  let pendingImages = [];
  const imageCache = new Map();
  let unseen = 0;
  let installEvent = null;
  try { const c = JSON.parse(store.get('sdb_cache') || 'null'); if (c) { rows = c.rows; } } catch (e) { /* bản lưu hỏng */ }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  // ---------- gọi máy chủ ----------
  // text/plain để trình duyệt không gửi preflight, Apps Script không trả lời được OPTIONS
  async function api(action, body) {
    if (!API_URL) throw new Error('Chưa dán link máy chủ vào config.js.');
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, token }, body)),
      });
    } catch (e) { throw new Error('Không có mạng, chưa lưu được.'); }
    let out;
    try { out = await res.json(); } catch (e) { throw new Error('Máy chủ trả lời lỗi, thử lại sau.'); }
    if (!out.ok) {
      if (/^SESSION:/.test(out.error)) { signOut(); }
      throw new Error(out.error.replace(/^(SESSION|CONFLICT):\s*/, ''));
    }
    return out.data;
  }

  function absorb(data, announce) {
    rev = data.rev;
    if (data.same) return false;
    if (announce) {
      const known = new Set(rows.map(b => b.id));
      const fresh = data.rows.filter(b => !known.has(b.id) && b.createdBy !== me);
      if (fresh.length) {
        const b = fresh[fresh.length - 1];
        toast(`🆕 ${b.createdBy}: ${b.name}, ${dayLabel(b.date)} ${b.time}, ${b.guests} khách`);
        unseen += fresh.length;
        if (navigator.setAppBadge) navigator.setAppBadge(unseen).catch(() => {});
        if (navigator.vibrate) navigator.vibrate(120);
      }
    }
    rows = data.rows;
    store.set('sdb_cache', JSON.stringify({ rows }));
    return true;
  }

  async function poll() {
    if (!token || document.visibilityState !== 'visible') return;
    try {
      const changed = absorb(await api('list', { rev }), true);
      if (!online || changed) { online = true; render(); }
    } catch (e) {
      if (online && token) { online = false; render(); }
    }
  }

  function clearBadge() {
    unseen = 0;
    if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  }

  // ---------- tin gửi Zalo ----------
  function bookingText(b) {
    return [
      `📌 ĐẶT BÀN ${dayLabel(b.date)} · ${b.time} · ${b.guests} khách`,
      b.phone ? `${b.name} · ${b.phone}` : b.name,
      tagsOf(b).join(' · '),
      b.table && `Bàn: ${b.table}`,
      b.block && `Block: ${b.block}`,
      b.dishes && `Món đặt trước: ${b.dishes}`,
      b.deposit ? `Cọc: ${money(b.deposit)}` : '',
      b.note && `Ghi chú: ${b.note}`,
      `Trạng thái: ${b.status}`,
    ].filter(Boolean).join('\n');
  }

  function dayText() {
    const list = rows.filter(b => b.date === date && ACTIVE.has(b.status)).sort(byTime);
    const guests = list.reduce((s, b) => s + b.guests, 0);
    const free = list.filter(b => b.area === NO_AREA).length;
    const counts = TAGS.map(([, label, test]) => `${label} ${list.filter(test).length}`).join(' · ') + (free ? ` · Không yêu cầu chỗ ${free}` : '');
    const total = list.reduce((s, b) => s + b.deposit, 0);
    return `📋 ĐẶT BÀN ${dayLabel(date)}: ${list.length} bàn, ${guests} khách\n${counts}\n${total ? `Tổng cọc: ${money(total)}\n` : ''}` +
      list.map(b => `${b.time} · ${b.guests} khách · ${b.name} · ${tagsOf(b).join(' · ')}${b.table ? ' · ' + b.table : ''}${b.block ? ' · Block: ' + b.block : ''}${b.dishes ? ' · Món: ' + b.dishes : ''}${b.deposit ? ' · Cọc ' + money(b.deposit) : ''}${b.note ? ' (' + b.note + ')' : ''}`).join('\n');
  }

  async function shareText(text) {
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Đã sao chép. Mở nhóm Zalo và dán vào.');
    } catch (e) { toast('Máy này không cho sao chép tự động.'); }
  }

  // ---------- màn hình ----------
  function showLogin(msg) {
    $('#app').innerHTML = `<div class="login"><section>
      <div><h1>Sổ Đặt Bàn</h1><p class="muted small">Nhập tên của bạn và mã do quản lý đưa.</p></div>
      <form id="f-login">
        <label class="f">Tên của bạn<input id="l-name" required maxlength="30" autocomplete="name" value="${esc(me)}" placeholder="VD: Huyền"></label>
        <label class="f">Mã<input id="l-code" required inputmode="numeric" autocomplete="off"></label>
        <div class="err" id="l-err">${esc(msg || '')}</div>
        <button class="btn primary" type="submit">Vào sổ</button>
      </form></section></div>`;
  }

  function signOut() {
    token = null; rows = []; rev = '';
    store.set('sdb_token', null); store.set('sdb_cache', null);
    if ($('#dlg').open) $('#dlg').close();
    showLogin();
  }

  function dayStrip() {
    const start = addDays(today(), -1);
    const list = [...Array(15)].map((_, i) => addDays(start, i));
    if (!list.includes(date)) list.unshift(date);
    return list.map(d => {
      const n = rows.filter(b => b.date === d && ACTIVE.has(b.status)).length;
      return `<button class="day ${d === date ? 'on' : ''}" data-act="date" data-v="${d}" aria-pressed="${d === date}">
        <small>${d === today() ? 'Nay' : DOW[parse(d).getDay()]}</small><b>${parse(d).getDate()}</b><i>${n ? n + ' bàn' : ''}</i></button>`;
    }).join('');
  }

  function statusButtons(b) {
    const set = (v, l, c = '') => `<button class="btn ${c}" data-act="status" data-id="${esc(b.id)}" data-v="${v}">${l}</button>`;
    if (b.status === 'Mới') return set('Đã xác nhận', 'Xác nhận', 'primary') + set('Đã huỷ', 'Huỷ', 'danger');
    if (b.status === 'Đã xác nhận') return set('Đã đến', 'Khách đã đến', 'primary') + set('Không đến', 'Không đến') + set('Đã huỷ', 'Huỷ', 'danger');
    return set('Đã xác nhận', 'Mở lại');
  }

  function lateNote(b) {
    if (b.date !== today() || b.status === 'Đã đến' || !ACTIVE.has(b.status)) return '';
    const now = new Date();
    const late = now.getHours() * 60 + now.getMinutes() - minutes(b.time);
    return late >= 15 ? `<span class="late">Trễ ${late} phút</span>` : '';
  }

  function card(b, showDate) {
    const tel = b.phone.replace(/[^\d+]/g, '');
    const facts = [`${b.guests} khách`, b.table].filter(Boolean).join(' · ');
    return `<article class="card ${STATUS_CLASS[b.status] || ''}">
      <div class="top">
        <div class="time">${esc(b.time)}</div>
        <div class="who2"><span class="name">${esc(b.name)}</span><span class="meta">${showDate ? esc(dayLabel(b.date)) + ' · ' : ''}${esc(facts)}</span>${lateNote(b)}</div>
        <span class="pill ${STATUS_CLASS[b.status] || ''}">${esc(b.status)}</span>
      </div>
      <div class="tags">${tagsOf(b).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      ${b.block ? `<div class="blk">Block: ${esc(b.block)}</div>` : ''}
      ${b.dishes || b.deposit ? `<div class="pre">${b.dishes ? `<div><b>Món đặt trước</b><p>${esc(b.dishes)}</p></div>` : ''}${b.deposit ? `<div class="dep"><span>Tiền cọc</span><b>${esc(money(b.deposit))}</b></div>` : ''}</div>` : ''}
      ${b.note ? `<div class="note">${esc(b.note)}</div>` : ''}
      ${canEdit() ? `<div class="acts">${statusButtons(b)}</div>` : ''}
      ${imgs(b).length ? `<div class="acts"><button class="btn" data-act="view" data-id="${esc(b.id)}">Xem ${imgs(b).length} hình</button></div>` : ''}
      <div class="acts tight">
        ${tel ? `<a class="btn" href="tel:${esc(tel)}">Gọi</a>
        <a class="btn" href="https://zalo.me/${esc(tel)}" target="_blank" rel="noopener">Zalo</a>` : ''}
        <button class="btn" data-act="share" data-id="${esc(b.id)}">Gửi nhóm</button>
        ${canEdit() ? `<button class="btn" data-act="edit" data-id="${esc(b.id)}">Sửa</button>` : ''}
      </div>
      <div class="by">${esc(b.source)} · ${esc(b.createdBy)} ghi${b.updatedBy && b.updatedBy !== b.createdBy ? ` · ${esc(b.updatedBy)} sửa` : ''}</div>
    </article>`;
  }

  function installTip() {
    if (matchMedia('(display-mode: standalone)').matches || navigator.standalone || store.get('sdb_notip')) return '';
    const ua = navigator.userAgent;
    let text = '';
    if (/Zalo/i.test(ua)) text = 'Đang mở trong Zalo. Chọn “Mở bằng trình duyệt” rồi cài app ra màn hình.';
    else if (installEvent) return `<div class="tip"><span>Cài app ra màn hình điện thoại để mở nhanh.</span><button class="btn primary" data-act="install">Cài</button></div>`;
    else if (/iPhone|iPad/.test(ua)) text = 'Cài app: trong Safari bấm nút Chia sẻ, rồi “Thêm vào MH chính”.';
    if (!text) return '';
    return `<div class="tip"><span>${text}</span><button class="btn" data-act="notip">Ẩn</button></div>`;
  }

  function decorLine(active) {
    const parts = DECOR_ITEMS.map(x => [x, active.filter(b => decorOf(b).includes(x)).length]).filter(p => p[1]);
    return parts.length ? `<p class="small muted">${parts.map(([x, n]) => `${x}: ${n}`).join(' · ')}</p>` : '';
  }

  /** Danh sách bàn, khu cần block trong ngày, xếp theo khu vực. */
  function blockPanel(active) {
    const list = active.filter(b => b.block && b.status !== 'Đã đến').sort(byTime);
    if (!list.length) return '';
    const group = area => {
      const hit = list.filter(b => b.area === area);
      return hit.length ? `<h3>${area}</h3>${hit.map(b => `<p><b>${esc(b.block)}</b> · ${esc(b.time)} · ${esc(b.name)}</p>`).join('')}` : '';
    };
    return `<section class="blocks"><h2>${date === today() ? 'Hôm nay' : 'Ngày này'} cần block</h2>${AREAS.map(group).join('')}</section>`;
  }

  function resultsHtml() {
    const q = fold(query.trim());
    const picked = TAGS.find(t => t[0] === tag);
    const list = q
      ? rows.filter(b => fold(`${b.name} ${b.phone} ${b.table} ${b.note} ${b.dishes} ${b.block || ''} ${tagsOf(b).join(' ')}`).includes(q)).sort(byTime).reverse()
      : rows.filter(b => b.date === date && (!picked || (ACTIVE.has(b.status) && picked[2](b))))
        .sort((a, b) => (ACTIVE.has(b.status) - ACTIVE.has(a.status)) || byTime(a, b));
    const active = rows.filter(b => b.date === date && ACTIVE.has(b.status));
    const guests = active.reduce((s, b) => s + b.guests, 0);
    const waiting = active.filter(b => b.status === 'Mới').length;
    const free = active.filter(b => b.area === NO_AREA);
    const deposits = active.reduce((s, b) => s + b.deposit, 0);
    const head = q ? `Tìm thấy ${list.length}` : `${date === today() ? 'Hôm nay' : DOW_FULL[parse(date).getDay()]}, ${ddmm(date)}`;
    const stats = TAGS.map(([key, label, test]) => {
      const hit = active.filter(test);
      const people = hit.reduce((s, b) => s + b.guests, 0);
      return `<button class="stat" data-act="tag" data-v="${key}" aria-pressed="${tag === key}"><b>${hit.length}</b><span>${label}</span><small>${people} khách</small></button>`;
    }).join('');
    return `<div class="sum">
        <div><h2>${head}</h2>${q ? '' : `<p>${active.length} bàn · ${guests} khách${waiting ? ` · ${waiting} chờ xác nhận` : ''}${deposits ? ` · cọc ${money(deposits)}` : ''}</p>`}</div>
        ${!q && active.length ? `<div class="acts"><button class="btn" data-act="share-day">Gửi cả ngày vào Zalo</button><button class="btn" data-act="export">In / xuất file</button></div>` : ''}
      </div>
      ${q ? '' : `<div class="stats">${stats}</div>${free.length ? `<p class="small muted">Không yêu cầu chỗ: ${free.length} bàn · ${free.reduce((s, b) => s + b.guests, 0)} khách</p>` : ''}${decorLine(active)}${blockPanel(active)}`}
      <div class="list">${list.length ? list.map(b => card(b, !!q)).join('') : `<div class="empty">${q ? 'Không tìm thấy đặt bàn nào.' : picked ? `Không có bàn ${picked[1]} ngày này.` : 'Ngày này chưa có đặt bàn.'}</div>`}</div>`;
  }

  /** Đang gõ tìm kiếm thì không thay ô nhập, nếu không bộ gõ Telex trên điện thoại sẽ bị ngắt. */
  function renderResults() {
    $('#results').innerHTML = resultsHtml();
  }

  function render() {
    if (!token) return;
    if (document.activeElement && document.activeElement.id === 'q') { renderResults(); return; }
    const scroll = $('.days') ? $('.days').scrollLeft : 0;
    $('#app').innerHTML = `
      <header class="band"><div class="gut">
        <h1>Sổ Đặt Bàn</h1>
        <div class="who"><span class="dot ${online ? '' : 'off'}" title="${online ? 'Đang kết nối' : 'Mất kết nối'}"></span><b>${esc(me)}</b>${canEdit() ? '' : '<span class="ro">Chỉ xem</span>'}<button class="btn" data-act="logout">Thoát</button></div>
      </div></header>
      <main class="gut">
        ${online ? '' : `<div class="tip"><span>Mất kết nối. Đang xem bản lưu gần nhất, chưa thêm hoặc sửa được.</span></div>`}
        ${installTip()}
        <div class="days">${dayStrip()}</div>
        <div class="tools">
          <input type="search" id="q" placeholder="Tìm tên, SĐT, bàn" value="${esc(query)}" aria-label="Tìm đặt bàn">
          <input type="date" id="pick" value="${date}" aria-label="Chọn ngày">
        </div>
        <div id="results">${resultsHtml()}</div>
      </main>
      ${canEdit() ? `<button class="fab" data-act="new">+ Đặt bàn</button>` : ''}`;
    if (scroll) $('.days').scrollLeft = scroll;
  }

  // ---------- in và xuất file ----------
  const COLUMNS = [
    ['Giờ', b => b.time, 7], ['Khách', b => b.name, 20], ['SĐT', b => b.phone, 13], ['Số khách', b => b.guests, 8],
    ['Bàn', b => b.table, 10], ['Khu vực', b => tagsOf(b).join(', '), 24], ['Block', b => b.block, 16],
    ['Món đặt trước', b => b.dishes, 26], ['Cọc', b => (b.deposit ? money(b.deposit) : ''), 11],
    ['Ghi chú', b => b.note, 22], ['Trạng thái', b => b.status, 12],
  ];
  const exportList = () => rows.filter(b => b.date === date && ACTIVE.has(b.status)).sort(byTime);

  function exportTitle(list) {
    const guests = list.reduce((s, b) => s + b.guests, 0);
    const counts = TAGS.map(([, label, test]) => `${label} ${list.filter(test).length}`).join(' · ');
    return [`Đặt bàn ${dayLabel(date)}/${parse(date).getFullYear()}`, `${list.length} bàn · ${guests} khách · ${counts}`];
  }

  function openExport() {
    const v = $('#viewer');
    v.innerHTML = `<div class="bk"><div class="dh"><h2>Xuất danh sách ${esc(dayLabel(date))}</h2><button class="btn" type="button" data-act="close-view">Đóng</button></div>
      <button class="btn primary" data-act="print">In hoặc lưu PDF</button>
      <button class="btn" data-act="excel">Tải file Excel</button>
      <p class="small muted">Gồm các bàn còn hiệu lực trong ngày, không gồm bàn đã huỷ và không đến.</p></div>`;
    v.showModal();
  }

  function printDay() {
    const list = exportList();
    const [title, sub] = exportTitle(list);
    $('#print').innerHTML = `<h1>${esc(title)}</h1><p>${esc(sub)}</p><table><thead><tr>${COLUMNS.map(c => `<th>${c[0]}</th>`).join('')}</tr></thead>
      <tbody>${list.map(b => `<tr>${COLUMNS.map(c => `<td>${esc(c[1](b))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    window.print();
  }

  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/xlsx.full.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Không tải được công cụ Excel, kiểm tra mạng.'));
      document.head.appendChild(s);
    });
  }

  async function excelDay() {
    await loadXlsx();
    const list = exportList();
    const [title, sub] = exportTitle(list);
    const sheet = XLSX.utils.aoa_to_sheet([[title], [sub], [], COLUMNS.map(c => c[0]), ...list.map(b => COLUMNS.map(c => c[1](b)))]);
    sheet['!cols'] = COLUMNS.map(c => ({ wch: c[2] }));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Dat ban');
    const file = new File([XLSX.write(book, { type: 'array', bookType: 'xlsx' })], `dat-ban-${date}.xlsx`,
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---------- form ----------
  function openForm(b) {
    editing = b || null;
    pendingImages = [];
    const v = b || { date, time: '', name: '', phone: '', guests: 2, table: '', area: '', view: false, decor: false, deposit: '', dishes: '', source: 'Điện thoại', note: '' };
    const dlg = $('#dlg');
    dlg.innerHTML = `<form class="bk" id="f-bk" novalidate>
      <div class="dh"><h2 id="dlg-t">${b ? 'Sửa đặt bàn' : 'Đặt bàn mới'}</h2><button class="btn" type="button" data-act="close">Đóng</button></div>
      <div class="two">
        <label class="f">Ngày<input type="date" id="f-date" required value="${esc(v.date)}"></label>
        <label class="f">Giờ<input type="time" id="f-time" required value="${esc(v.time)}"></label>
      </div>
      <div class="quick">${QUICK_TIMES.map(t => `<button type="button" data-act="time" data-v="${t}">${t}</button>`).join('')}</div>
      <label class="f">Tên khách<input id="f-name" required maxlength="60" value="${esc(v.name)}" autocomplete="off"></label>
      <div class="two">
        <label class="f">Số điện thoại (nếu có)<input id="f-phone" type="tel" inputmode="tel" maxlength="15" value="${esc(v.phone)}" autocomplete="off"></label>
        <label class="f">Số khách<input id="f-guests" required type="number" inputmode="numeric" min="1" max="500" value="${esc(v.guests)}"></label>
      </div>
      <label class="f">Số bàn<input id="f-table" maxlength="40" value="${esc(v.table)}" placeholder="VD: Bàn 5" autocomplete="off"></label>
      <label class="f">Block bàn / khu<input id="f-block" maxlength="80" value="${esc(v.block)}" placeholder="VD: Bàn 5, 6 hoặc cả sân vườn" autocomplete="off"></label>
      <div class="opts three" role="radiogroup" aria-label="Khu vực">${AREAS.map(a => `<label class="opt"><input type="radio" name="f-area" value="${a}" ${a === v.area ? 'checked' : ''}>${a}</label>`).join('')}</div>
      <div class="opts">
        <label class="opt"><input type="checkbox" id="f-view" ${v.view ? 'checked' : ''}>Sát view</label>
        <label class="opt"><input type="checkbox" id="f-decor" ${v.decor ? 'checked' : ''}>Bàn decor</label>
      </div>
      <div class="opts sub" id="f-decor-sub" ${v.decor ? '' : 'hidden'}>${DECOR_ITEMS.map(x => `<label class="opt"><input type="checkbox" name="f-di" value="${x}" ${decorOf(v).includes(x) ? 'checked' : ''}>${x}</label>`).join('')}</div>
      <fieldset class="box">
        <legend>Món đặt trước &amp; tiền cọc</legend>
        <label class="f">Món đặt trước<textarea id="f-dishes" rows="3" maxlength="500" placeholder="VD: 2 lẩu gà, 1 bánh kem">${esc(v.dishes)}</textarea></label>
        <label class="f">Tiền cọc (đồng)<input id="f-deposit" type="number" inputmode="numeric" min="0" step="1000" value="${esc(v.deposit || '')}" placeholder="Để trống nếu chưa cọc"></label>
      </fieldset>
      <div class="f"><span>Hình (bàn chỉ định, mẫu decor…)</span><div class="thumbs" id="f-thumbs"></div>
        <label class="btn">Thêm hình<input type="file" id="f-files" accept="image/*" multiple hidden></label></div>
      <label class="f">Khách đặt qua<select id="f-source">${SOURCES.map(s => `<option ${s === v.source ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="f">Ghi chú<textarea id="f-note" rows="2" maxlength="300" placeholder="VD: sinh nhật, ghế em bé">${esc(v.note)}</textarea></label>
      <div class="warn" id="f-warn" role="alert"></div>
      <div class="err" id="f-err"></div>
      <button class="btn primary" type="submit" id="f-save">${b ? 'Lưu thay đổi' : 'Lưu đặt bàn'}</button>
    </form>`;
    dlg.showModal();
    updateWarn();
    renderThumbs();
  }

  // ---------- hình ----------
  async function getImage(file) {
    if (!imageCache.has(file)) imageCache.set(file, `data:image/jpeg;base64,${(await api('image', { file })).data}`);
    return imageCache.get(file);
  }

  function fillImages(root) {
    root.querySelectorAll('img[data-file]').forEach(el => {
      getImage(el.dataset.file).then(src => { el.src = src; }).catch(() => { el.alt = 'Không tải được hình'; });
    });
  }

  function renderThumbs() {
    const box = $('#f-thumbs');
    if (!box) return;
    const saved = editing ? imgs(editing) : [];
    box.innerHTML = saved.map(f => `<div class="thumb"><img data-file="${esc(f)}" alt="Hình đã lưu"><button type="button" data-act="rm-img" data-file="${esc(f)}" aria-label="Xoá hình">×</button></div>`).join('') +
      pendingImages.map((d, i) => `<div class="thumb"><img src="data:image/jpeg;base64,${d}" alt="Hình chờ lưu"><button type="button" data-act="rm-new" data-i="${i}" aria-label="Bỏ hình">×</button></div>`).join('');
    fillImages(box);
  }

  /** Thu nhỏ trên máy trước khi gửi: ảnh điện thoại vài MB còn khoảng 200 KB, mạng yếu vẫn tải được. */
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, IMAGE_SIDE / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * k);
        canvas.height = Math.round(img.height * k);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.8).split(',')[1]);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Không đọc được hình này.')); };
      img.src = url;
    });
  }

  async function addFiles(files) {
    const used = (editing ? imgs(editing).length : 0) + pendingImages.length;
    const room = MAX_IMAGES - used;
    if (files.length > room) toast(`Mỗi đặt bàn tối đa ${MAX_IMAGES} hình.`);
    for (const f of files.slice(0, Math.max(0, room))) {
      try { pendingImages.push(await shrink(f)); } catch (e) { toast(e.message); }
    }
    renderThumbs();
  }

  function openViewer(b) {
    const v = $('#viewer');
    v.innerHTML = `<div class="bk"><div class="dh"><h2>${esc(b.name)} · ${esc(b.time)}</h2><button class="btn" type="button" data-act="close-view">Đóng</button></div>
      ${imgs(b).map(f => `<img class="full" data-file="${esc(f)}" alt="Hình đặt bàn">`).join('')}</div>`;
    v.showModal();
    fillImages(v);
  }

  /** Cảnh báo trùng, chỉ nhắc chứ không chặn: cùng bàn gần giờ, hoặc cùng SĐT trong ngày. */
  function clashes(v) {
    const others = rows.filter(b => b.date === v.date && ACTIVE.has(b.status) && !(editing && b.id === editing.id));
    const out = [];
    const table = fold(v.table.trim());
    if (table && v.time) {
      others.filter(b => fold(b.table.trim()) === table && Math.abs(minutes(b.time) - minutes(v.time)) < CLASH_MINUTES)
        .forEach(b => out.push(`${b.table} đã có ${b.name} lúc ${b.time}.`));
    }
    const phone = v.phone.replace(/\D/g, '');
    if (phone.length >= 9) {
      others.filter(b => b.phone.replace(/\D/g, '') === phone)
        .forEach(b => out.push(`SĐT này đã đặt lúc ${b.time} cùng ngày (${b.name}).`));
    }
    return [...new Set(out)];
  }

  function updateWarn() {
    const box = $('#f-warn');
    if (!box) return;
    const lines = clashes({ date: $('#f-date').value, time: $('#f-time').value, table: $('#f-table').value, phone: $('#f-phone').value });
    box.textContent = lines.length ? '⚠ ' + lines.join(' ') : '';
  }

  async function submitBooking() {
    const btn = $('#f-save');
    const booking = {
      id: editing ? editing.id : (btn.dataset.id = btn.dataset.id || newId()),
      ver: editing ? editing.ver : 0,
      date: $('#f-date').value, time: $('#f-time').value, name: $('#f-name').value, phone: $('#f-phone').value,
      guests: Number($('#f-guests').value), table: $('#f-table').value,
      area: ($('input[name=f-area]:checked') || {}).value || '', view: $('#f-view').checked, decor: $('#f-decor').checked, deposit: Number($('#f-deposit').value || 0), dishes: $('#f-dishes').value, block: $('#f-block').value,
      decorItems: [...document.querySelectorAll('[name=f-di]:checked')].map(x => x.value).join(','),
      source: $('#f-source').value, note: $('#f-note').value,
    };
    btn.disabled = true;
    $('#f-err').textContent = '';
    try {
      absorb(await api('save', { booking }));
      online = true;
      const queue = pendingImages.slice();
      let failed = 0;
      for (let i = 0; i < queue.length; i++) {
        btn.textContent = `Đang tải hình ${i + 1}/${queue.length}…`;
        try { absorb(await api('upload', { id: booking.id, data: queue[i] })); } catch (e) { failed++; }
      }
      pendingImages = [];
      $('#dlg').close();
      date = booking.date;
      query = '';
      tag = '';
      render();
      toast(failed ? `Đã lưu, nhưng ${failed} hình chưa tải lên được. Mở Sửa để thêm lại.` : editing ? 'Đã lưu thay đổi.' : 'Đã lưu đặt bàn.');
    } catch (e) {
      $('#f-err').textContent = e.message;
      btn.disabled = false;
      poll(); // bị chặn vì người khác vừa sửa: tải bản mới để mở lại là thấy ngay
    }
  }

  // ---------- sự kiện ----------
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (document.activeElement && document.activeElement.id === 'q') document.activeElement.blur(); // Safari không tự bỏ focus khi bấm nút
    const find = () => rows.find(b => b.id === t.dataset.id);
    if (act === 'date') { date = t.dataset.v; query = ''; tag = ''; clearBadge(); render(); }
    else if (act === 'tag') { tag = tag === t.dataset.v ? '' : t.dataset.v; renderResults(); }
    else if (act === 'new') { clearBadge(); openForm(); }
    else if (act === 'edit') openForm(find());
    else if (act === 'close') $('#dlg').close();
    else if (act === 'view') openViewer(find());
    else if (act === 'export') openExport();
    else if (act === 'print') { $('#viewer').close(); printDay(); }
    else if (act === 'excel') { $('#viewer').close(); excelDay().catch(err => toast(err.message)); }
    else if (act === 'close-view') $('#viewer').close();
    else if (act === 'rm-new') { pendingImages.splice(Number(t.dataset.i), 1); renderThumbs(); }
    else if (act === 'rm-img') {
      t.disabled = true;
      try {
        absorb(await api('removeImage', { id: editing.id, file: t.dataset.file }));
        editing = rows.find(b => b.id === editing.id) || null; // xoá hình tăng phiên bản, phải giữ bản mới để lưu được
        renderThumbs();
        render();
      } catch (err) { toast(err.message); t.disabled = false; }
    }
    else if (act === 'time') { $('#f-time').value = t.dataset.v; updateWarn(); }
    else if (act === 'share') shareText(bookingText(find()));
    else if (act === 'share-day') shareText(dayText());
    else if (act === 'logout') signOut();
    else if (act === 'notip') { store.set('sdb_notip', '1'); render(); }
    else if (act === 'install' && installEvent) { installEvent.prompt(); installEvent = null; render(); }
    else if (act === 'status') {
      t.disabled = true;
      try { absorb(await api('status', { id: t.dataset.id, status: t.dataset.v })); render(); toast(`Đã chuyển: ${t.dataset.v}`); }
      catch (err) { toast(err.message); t.disabled = false; }
    }
  });

  document.addEventListener('input', e => {
    if (e.target.id === 'q') { query = e.target.value; renderResults(); }
    else if (['f-date', 'f-time', 'f-table', 'f-phone'].includes(e.target.id)) updateWarn();
  });

  document.addEventListener('change', e => {
    if (e.target.id === 'f-decor') { $('#f-decor-sub').hidden = !e.target.checked; return; }
    if (e.target.id === 'f-files') { addFiles([...e.target.files]); e.target.value = ''; return; }
    if (e.target.id === 'pick' && e.target.value) { date = e.target.value; query = ''; tag = ''; render(); }
  });

  document.addEventListener('submit', async e => {
    e.preventDefault();
    if (e.target.id === 'f-bk') { submitBooking(); return; }
    if (e.target.id !== 'f-login') return;
    const err = $('#l-err');
    err.textContent = 'Đang vào…';
    try {
      const data = await api('login', { name: $('#l-name').value, code: $('#l-code').value });
      token = data.token; me = data.name; role = data.role || 'edit';
      store.set('sdb_token', token); store.set('sdb_name', me); store.set('sdb_role', role);
      absorb(data);
      online = true;
      render();
    } catch (ex) { err.textContent = ex.message; }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { clearBadge(); poll(); }
  });
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; render(); });
  setInterval(poll, POLL_MS);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  if (token) { render(); poll(); } else showLogin();
})();
