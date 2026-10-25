(function () {
  'use strict';

  /* ---------- иллюстрации карт (рисуются кодом) ---------- */
  function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
  var PAL = {
    dust:    { sky: ['#6f8aa0', '#c9b88f'], far: '#a58f66', mid: '#c2a877', near: '#8e7650', dark: '#5c4a30' },
    dust2:   { sky: ['#7e9ab0', '#d4c196'], far: '#b09a6e', mid: '#cdb381', near: '#9a8156', dark: '#665236' },
    inferno: { sky: ['#8aa0a6', '#d9bf94'], far: '#b79a70', mid: '#d0b184', near: '#a07a54', dark: '#6a4a30' },
    harbor:  { sky: ['#8db6d6', '#c8d9e2'], far: '#7d8d96', mid: '#9fa9ae', near: '#6b7479', dark: '#3f4a52' },
    night:   { sky: ['#1d3a30', '#4a6b5a'], far: '#355245', mid: '#456a58', near: '#2b4a3b', dark: '#142a21' }
  };
  function kindFor(name, seed) {
    name = String(name || '').toLowerCase();
    if (/dust/.test(name)) return seed % 2 ? 'dust2' : 'dust';
    if (/inferno|italy|tuscan|aztec/.test(name)) return 'inferno';
    if (/nuke|port|train|cbble|cobble|harbor|office/.test(name)) return 'harbor';
    if (name === 'news') return ['night', 'dust', 'harbor', 'inferno'][seed % 4];
    var keys = ['dust', 'dust2', 'inferno', 'harbor', 'night'], h = 0, i;
    for (i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997;
    return keys[(h + seed) % keys.length];
  }
  var gid = 0;
  function mapArt(kind, seed) {
    var p = PAL[kind] || PAL.dust, r = rng(seed * 977 + 13), x, w, h, y, dx, id = 'ga' + (++gid), o = '';
    o += '<svg viewBox="0 0 200 80" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + p.sky[0] + '"/><stop offset="1" stop-color="' + p.sky[1] + '"/></linearGradient></defs>';
    o += '<rect width="200" height="80" fill="url(#' + id + ')"/>';
    if (kind === 'harbor') o += '<rect y="34" width="200" height="14" fill="#4f7fa3" opacity=".75"/>';
    for (x = -5; x < 205; x += w) { w = 18 + r() * 22; h = 18 + r() * 22; o += '<rect x="' + x.toFixed(1) + '" y="' + (46 - h).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + (h + 4).toFixed(1) + '" fill="' + p.far + '"/>'; }
    for (x = -10; x < 205; x += w) {
      w = 26 + r() * 30; h = 22 + r() * 22; y = 62 - h;
      o += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + (h + 20).toFixed(1) + '" fill="' + p.mid + '"/>';
      o += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="3" fill="' + p.near + '"/>';
      if (r() > 0.35) { dx = x + w * (0.25 + r() * 0.4); o += '<path d="M' + dx.toFixed(1) + ' ' + (y + h + 4).toFixed(1) + 'v-9a4 4 0 018 0v9z" fill="' + p.dark + '"/>'; }
      if (r() > 0.5) o += '<rect x="' + (x + 4).toFixed(1) + '" y="' + (y + 8).toFixed(1) + '" width="5" height="7" fill="' + p.dark + '" opacity=".8"/>';
    }
    o += '<rect y="62" width="200" height="18" fill="' + p.near + '"/><rect y="62" width="200" height="2" fill="' + p.dark + '" opacity=".5"/><rect width="200" height="80" fill="#0b3a22" opacity=".28"/></svg>';
    return o;
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-art]'), function (el) {
    var seed = parseInt(el.getAttribute('data-seed') || '1', 10) || 1;
    el.insertAdjacentHTML('afterbegin', mapArt(kindFor(el.getAttribute('data-art'), seed), seed));
  });

  /* ---------- уведомления ---------- */
  var toastEl = document.getElementById('toast'), toastTimer;
  function toast(html) {
    if (!toastEl) return;
    toastEl.innerHTML = html; toastEl.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 5200);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------- подключение к серверу: копируем команду connect ---------- */
  function copyText(text) {
    function fallback() {
      var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); return ok;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
    return Promise.resolve(fallback());
  }
  document.addEventListener('click', function (e) {
    var ct = e.target.closest('[data-copytext]');
    if (ct) { copyText(ct.getAttribute('data-copytext')).then(function (ok) { toast(ok ? 'Номер карты скопирован.' : 'Не удалось скопировать, выделите номер вручную.'); }); return; }
    var a = e.target.closest('[data-copy]');
    if (!a) return;
    var cmd = a.getAttribute('data-copy');
    copyText(cmd).then(function (ok) {
      toast((ok ? 'Команда скопирована. ' : '') + 'Если игра не запустилась сама, откройте консоль (<b>~</b>) и введите: <b>' + esc(cmd) + '</b>');
    });
  });

  /* ---------- загрузка картинок в админке (файл → base64 → скрытое поле) ---------- */
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || !el.matches || !el.matches('[data-upload]')) return;
    var target = document.getElementById(el.getAttribute('data-upload'));
    if (!target) return;
    var file = el.files && el.files[0];
    if (!file) { target.value = ''; return; }
    if (!/^image\//.test(file.type)) { toast('Нужен файл изображения (JPG, PNG, WebP или GIF).'); el.value = ''; target.value = ''; return; }
    if (file.size > 8 * 1024 * 1024) { toast('Картинка слишком большая — максимум 8 МБ.'); el.value = ''; target.value = ''; return; }
    var r = new FileReader();
    r.onload = function () { target.value = r.result; toast('Картинка готова: <b>' + esc(file.name) + '</b>. Нажмите «Сохранить», чтобы применить.'); };
    r.onerror = function () { toast('Не удалось прочитать файл.'); };
    r.readAsDataURL(file);
  });

  /* ---------- подтверждение опасных действий ---------- */
  document.addEventListener('submit', function (e) {
    var f = e.target, msg = f.getAttribute && f.getAttribute('data-confirm');
    if (!msg || f.__ok) return;
    e.preventDefault();
    var m = document.createElement('div'); m.className = 'modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
    m.innerHTML = '<div><p></p><div class="row"><button type="button" class="btn" data-no>Отмена</button><button type="button" class="btn solid" data-yes>Подтвердить</button></div></div>';
    m.querySelector('p').textContent = msg; document.body.appendChild(m);
    var yes = m.querySelector('[data-yes]'); yes.focus();
    function close() { m.remove(); }
    m.querySelector('[data-no]').onclick = close;
    m.addEventListener('click', function (ev) { if (ev.target === m) close(); });
    document.addEventListener('keydown', function esc2(ev) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); } });
    yes.onclick = function () { f.__ok = true; close(); f.requestSubmit ? f.requestSubmit() : f.submit(); };
  });

  /* ---------- живое обновление счётчиков ---------- */
  function refresh() {
    if (document.hidden) return;
    fetch('/api/live', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      var t = document.querySelector('[data-total-online]'), m = document.querySelector('[data-total-max]');
      if (t) t.textContent = d.players; if (m) m.textContent = d.max;
      Array.prototype.forEach.call(document.querySelectorAll('[data-site-online]'), function (el) { if (d.site !== undefined) el.textContent = d.site; });
      d.servers.forEach(function (s) {
        var n = document.querySelector('[data-srv-players="' + s.id + '"]'), st = document.querySelector('[data-srv-state="' + s.id + '"]');
        if (n) n.textContent = s.online ? s.players + '/' + s.max : '—';
        if (st) { st.className = 'state ' + (s.online ? 'on' : 'off'); st.textContent = s.online ? 'ONLINE' : 'OFFLINE'; }
      });
    }).catch(function () {});
  }
  setInterval(refresh, 20000);
})();
