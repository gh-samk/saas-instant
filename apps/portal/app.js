(function () {
  'use strict';
  var T = window.PORTAL_STRINGS || {};
  var NS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    open: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
    empty: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
    error: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 8v4', 'M12 16h.01'],
    retry: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5']
  };

  function icon(name) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    ICONS[name].forEach(function (d) {
      var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p);
    });
    return s;
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function set(id, text) { var e = document.getElementById(id); if (e && text) e.textContent = text; }

  set('t-skip', T.skip); set('t-intro', T.intro);
  var zustand = document.getElementById('zustand');
  var list = document.getElementById('liste');
  var main = document.getElementById('inhalt');
  if (T.listLabel) list.setAttribute('aria-label', T.listLabel);

  // Nur http(s)-Adressen werden verlinkt (kein javascript: o. ä.).
  function safeUrl(value, base) {
    try {
      var u = new URL(value, base);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u : null;
    } catch (e) { return null; }
  }

  function setTitle(data) {
    var t = data && typeof data.title === 'string' && data.title.trim() ? data.title.trim() : (T.title || 'Portal');
    set('t-title', t);
    document.title = t;
  }

  function card(entry) {
    var url = safeUrl(entry.url, location.href);
    if (!url || !entry.name) return null;
    var li = el('li', 'karte');
    var logo = entry.logo ? safeUrl(entry.logo, location.href) : null;
    if (logo) {
      var img = document.createElement('img');
      img.src = logo.href; img.alt = ''; img.width = 48; img.height = 48; img.loading = 'lazy';
      li.appendChild(img);
    }
    var text = el('div', 'text');
    text.appendChild(el('h2', '', String(entry.name)));
    text.appendChild(el('p', 'host', url.host));
    li.appendChild(text);
    var a = el('a', 'knopf');
    a.href = url.href;
    a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', (T.openLabel || '{name}').replace('{name}', String(entry.name)));
    a.appendChild(el('span', '', T.open || 'Open'));
    a.appendChild(icon('open'));
    li.appendChild(a);
    return li;
  }

  function showState(kind, title, hint, withRetry) {
    zustand.className = 'zustand' + (kind === 'error' ? ' fehler' : '');
    zustand.textContent = '';
    if (ICONS[kind]) { var s = el('div', 'symbol'); s.appendChild(icon(kind)); zustand.appendChild(s); }
    zustand.appendChild(el('p', 'titel', title));
    if (hint) {
      var h = el('p', 'hinweis');
      // „bin/saas-instant add“ als Code hervorheben, ohne HTML einzufügen.
      var m = hint.match(/^(.*?)(bin\/saas-instant add)(.*)$/);
      if (m) { h.appendChild(document.createTextNode(m[1])); h.appendChild(el('code', '', m[2])); h.appendChild(document.createTextNode(m[3])); }
      else h.textContent = hint;
      zustand.appendChild(h);
    }
    if (withRetry) {
      var b = el('button', 'knopf zweit');
      b.type = 'button';
      b.appendChild(icon('retry'));
      b.appendChild(el('span', '', T.retry || 'Retry'));
      b.addEventListener('click', load);
      zustand.appendChild(b);
    }
    zustand.hidden = false;
  }

  function showLoading() {
    list.textContent = '';
    main.setAttribute('aria-busy', 'true');
    for (var i = 0; i < 3; i++) {
      var li = el('li', 'skelett');
      li.setAttribute('aria-hidden', 'true');
      li.appendChild(el('span')); li.appendChild(el('span')); li.appendChild(el('span'));
      list.appendChild(li);
    }
    showState('loading', T.loading || '', '', false);
  }

  function load() {
    showLoading();
    fetch('registry.json', { cache: 'no-store', credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (data) {
        setTitle(data);
        var entries = Array.isArray(data && data.entries) ? data.entries : [];
        list.textContent = '';
        entries.forEach(function (e) { var c = card(e || {}); if (c) list.appendChild(c); });
        if (list.children.length) { zustand.hidden = true; zustand.textContent = ''; }
        else showState('empty', T.emptyTitle || '', T.emptyHint || '', false);
      })
      .catch(function () {
        list.textContent = '';
        showState('error', T.errorTitle || '', T.errorHint || '', true);
      })
      .then(function () { main.removeAttribute('aria-busy'); });
  }

  setTitle(null);
  load();
})();
