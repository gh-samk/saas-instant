(function () {
  'use strict';
  var T = window.PORTAL_STRINGS || {};
  function set(id, text) { var el = document.getElementById(id); if (el && text) el.textContent = text; }
  set('t-title', T.title); set('t-intro', T.intro); set('t-skip', T.skip);
  if (T.title) document.title = T.title;

  var status = document.getElementById('status');
  var list = document.getElementById('liste');

  // Nur http(s)-Adressen werden verlinkt (kein javascript: o. ä.).
  function safeUrl(value, base) {
    try {
      var u = new URL(value, base);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch (e) { return null; }
  }

  function card(entry) {
    var href = safeUrl(entry.url, location.href);
    if (!href || !entry.name) return null;
    var li = document.createElement('li');
    li.className = 'card';
    var logo = entry.logo ? safeUrl(entry.logo, location.href) : null;
    if (logo) {
      var img = document.createElement('img');
      img.src = logo; img.alt = ''; img.width = 48; img.height = 48; img.loading = 'lazy';
      li.appendChild(img);
    }
    var h = document.createElement('h2');
    h.textContent = String(entry.name);
    li.appendChild(h);
    var a = document.createElement('a');
    a.className = 'button';
    a.href = href;
    a.rel = 'noopener noreferrer';
    a.textContent = T.open || 'Open';
    a.setAttribute('aria-label', (T.openLabel || '{name}').replace('{name}', String(entry.name)));
    li.appendChild(a);
    return li;
  }

  status.textContent = T.loading || '';
  fetch('registry.json', { cache: 'no-store', credentials: 'omit' })
    .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then(function (data) {
      var entries = Array.isArray(data && data.entries) ? data.entries : [];
      var n = 0;
      entries.forEach(function (e) { var c = card(e || {}); if (c) { list.appendChild(c); n++; } });
      status.textContent = n ? '' : (T.empty || '');
    })
    .catch(function () { status.textContent = T.error || ''; });
})();
