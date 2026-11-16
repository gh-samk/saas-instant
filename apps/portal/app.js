// Portal: Verwaltungen als Liste (Launcher) plus Anmeldung, wenn der Anmeldedienst läuft.
// Ohne Anmeldedienst (ältere Installation) bleibt es der statische Launcher.
(function () {
  'use strict';
  var P = window.Portal, V = window.PortalViews, T = P.T, el = P.el;
  var title = T.title || 'Portal';

  // Step-up (erneute Bestätigung für eine Aktion) läuft in einem kleinen Popup der Verwaltung:
  // dort keine Navigation, nur das Nötigste (siehe .schlank in style.css).
  var slim = location.pathname.replace(/\/+$/, '') === '/auth/login' && new URLSearchParams(location.search).get('stepup') === '1';
  if (slim) document.body.classList.add('schlank');

  function set(id, text) { var e = document.getElementById(id); if (e && text) e.textContent = text; }
  set('t-skip', T.skip);
  var main = document.getElementById('inhalt');

  // Nur http(s)-Adressen werden verlinkt (kein javascript: o. ä.).
  function safeUrl(value, base) {
    try {
      var u = new URL(value, base);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u : null;
    } catch (e) { return null; }
  }

  function setTitle(data) {
    title = data && typeof data.title === 'string' && data.title.trim() ? data.title.trim() : (T.title || 'Portal');
    set('t-title', title);
    document.title = title;
  }

  // ---------- Kopf: Navigation ---------------------------------------------------------------
  function nav(me) {
    var n = document.getElementById('nav');
    P.clear(n);
    if (!me || slim) { n.hidden = true; return; }
    n.hidden = false;
    n.setAttribute('aria-label', T.navLabel);
    var items = [['/', T.navLauncher]];
    if (me.account.portalAdmin) items.push(['/auth/accounts', T.navAccounts]);
    items.push(['/auth/account', T.navAccount]);
    var ul = el('ul');
    items.forEach(function (it) {
      var li = el('li'); var a = el('a', '', it[1]); a.href = it[0];
      if (location.pathname === it[0]) a.setAttribute('aria-current', 'page');
      li.appendChild(a); ul.appendChild(li);
    });
    var out = el('li'); var a = el('a', 'abmelden', T.navLogout); a.href = '/oauth/logout'; out.appendChild(a); ul.appendChild(out);
    n.appendChild(ul);
  }

  // ---------- Launcher --------------------------------------------------------------------------
  function card(entry, role) {
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
    if (role) { var chips = el('ul', 'chips'); chips.appendChild(el('li', 'chip', role === 'admin' ? T.roleAdmin : T.roleStaff)); text.appendChild(chips); }
    li.appendChild(text);
    var target = url;
    if (role) {
      // Angemeldetes Portal: direkt in den Anmeldeablauf der Verwaltung (Single Sign-on).
      target = new URL('/api/auth/sso/start', url.origin);
      target.searchParams.set('return', url.pathname === '/' ? '/' : url.pathname);
      target.searchParams.set('stepup', '0');
    }
    var a = el('a', 'knopf');
    a.href = target.href;
    a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', (T.openLabel || '{name}').replace('{name}', String(entry.name)));
    a.appendChild(el('span', '', T.open || 'Open'));
    a.appendChild(P.icon('open'));
    li.appendChild(a);
    return li;
  }

  function launcher(me) {
    var root = P.page();
    var zustand = el('div', 'zustand'); zustand.id = 'zustand'; zustand.setAttribute('role', 'status'); zustand.setAttribute('aria-live', 'polite'); zustand.hidden = true;
    var list = el('ul', 'karten'); list.id = 'liste'; list.setAttribute('aria-label', T.listLabel || 'Verwaltungen');
    root.appendChild(zustand); root.appendChild(list);

    function showState(kind, ttl, hint, withRetry) {
      zustand.className = 'zustand' + (kind === 'error' ? ' fehler' : '');
      zustand.textContent = '';
      if (kind !== 'loading') { var s = el('div', 'symbol'); s.appendChild(P.icon(kind)); zustand.appendChild(s); }
      zustand.appendChild(el('p', 'titel', ttl));
      if (hint) {
        var h = el('p', 'hinweis');
        // „bin/saas-instant add“ als Code hervorheben, ohne HTML einzufügen.
        var m = hint.match(/^(.*?)(bin\/saas-instant add)(.*)$/);
        if (m) { h.appendChild(document.createTextNode(m[1])); h.appendChild(el('code', '', m[2])); h.appendChild(document.createTextNode(m[3])); }
        else h.textContent = hint;
        zustand.appendChild(h);
      }
      if (withRetry) {
        var b = el('button', 'knopf zweit'); b.type = 'button';
        b.appendChild(P.icon('retry')); b.appendChild(el('span', '', T.retry || 'Retry'));
        b.addEventListener('click', load);
        zustand.appendChild(b);
      }
      zustand.hidden = false;
    }

    function load() {
      list.textContent = '';
      main.setAttribute('aria-busy', 'true');
      for (var i = 0; i < 3; i++) {
        var li = el('li', 'skelett'); li.setAttribute('aria-hidden', 'true');
        li.appendChild(el('span')); li.appendChild(el('span')); li.appendChild(el('span'));
        list.appendChild(li);
      }
      showState('loading', T.loading || '', '', false);
      fetch('/registry.json', { cache: 'no-store', credentials: 'omit' })
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
        .then(function (data) {
          setTitle(data);
          var entries = Array.isArray(data && data.entries) ? data.entries : [];
          list.textContent = '';
          var shown = 0;
          entries.forEach(function (e) {
            e = e || {};
            // Mit Anmeldung nur Verwaltungen zeigen, für die das Konto eine Rolle hat.
            var role = me ? (me.roles || {})[e.slug] : null;
            if (me && !role) return;
            var c = card(e, role); if (c) { list.appendChild(c); shown++; }
          });
          if (shown) { zustand.hidden = true; zustand.textContent = ''; }
          else if (me && entries.length) showState('empty', T.noAccessTitle || '', T.noAccessHint || '', false);
          else showState('empty', T.emptyTitle || '', T.emptyHint || '', false);
        })
        .catch(function () { list.textContent = ''; showState('error', T.errorTitle || '', T.errorHint || '', true); })
        .then(function () { main.removeAttribute('aria-busy'); });
    }
    load();
  }

  // ---------- Start: Sitzung klären, dann Seite wählen -----------------------------------------------
  // Ergebnis: { me } mit Sitzung, { me: null } ohne, { legacy: true } wenn es keinen Anmeldedienst gibt.
  function session() {
    return P.api('GET', '/api/me').then(function (r) {
      if (r.ok && r.json && r.data && r.data.account) return { me: r.data };
      if (r.status === 401 && r.json && r.data && r.data.error === 'unauthenticated') return { me: null };
      return { legacy: true };
    }).catch(function () { return { legacy: true }; });
  }

  function start() {
    setTitle(null);
    var path = location.pathname.replace(/\/+$/, '') || '/';
    document.getElementById('t-intro').hidden = path.indexOf('/auth/') === 0;
    set('t-intro', T.intro);
    session().then(function (s) {
      var isAuthPage = path.indexOf('/auth/') === 0;
      if (s.legacy) {
        if (isAuthPage) {
          var root = P.page(); root.appendChild(P.heading(T.serviceDownTitle)); var m = P.messageBox(); P.message(m, 'fehler', T.serviceDownHint); root.appendChild(m);
          return;
        }
        nav(null);
        return launcher(null);
      }
      nav(s.me);
      var ctx = { me: s.me };
      if (path === '/auth/login') return V.login(ctx);
      if (path === '/auth/setup') return V.setup();
      if (!s.me) {
        // Ohne Sitzung geht es nur zur Anmeldung.
        location.replace('/auth/login');
        return;
      }
      if (path === '/auth/accounts') return V.admin(ctx);
      if (path === '/auth/account') return V.account(ctx);
      if (isAuthPage) { location.replace('/'); return; }
      launcher(s.me);
    });
  }

  // Registry-Titel auch auf den Anmeldeseiten, sobald bekannt.
  fetch('/registry.json', { cache: 'no-store', credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d) setTitle(d); }).catch(function () {});
  start();
})();
