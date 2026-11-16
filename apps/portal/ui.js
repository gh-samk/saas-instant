// Gemeinsame Bausteine des Portals: DOM-Hilfen, Aufrufe an den Anmeldedienst, Passkey-Umwandlung.
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var T = window.PORTAL_STRINGS || {};

  var ICONS = {
    open: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
    empty: ['M22 12h-6l-2 3h-4l-2-3H2', 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'],
    error: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 8v4', 'M12 16h.01'],
    retry: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
    key: ['M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4'],
    copy: ['M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
    loading: ['M21 12a9 9 0 1 1-6.22-8.56']
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

  // el('div.klasse', { attr: 'wert' }, 'Text' | [Kinder])
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null && text !== '') e.textContent = text;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function fmt(template, values) {
    return String(template || '').replace(/\{(\w+)\}/g, function (m, k) { return values && values[k] !== undefined ? values[k] : m; });
  }
  function dateText(value) {
    if (!value) return '';
    try { return new Date(value).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; }
  }

  // ---------- Aufrufe an den Anmeldedienst ----------------------------------------
  var csrf = null;
  function getCsrf(force) {
    if (csrf && !force) return Promise.resolve(csrf);
    return fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) { csrf = d.csrf; return csrf; });
  }

  // Liefert { status, ok, data, json }. `json` ist false, wenn keine JSON-Antwort kam
  // (z. B. Fehlerseite des Proxys, wenn der Anmeldedienst fehlt). Netzwerkfehler werfen.
  function api(method, path, body, retried) {
    var opts = { method: method, credentials: 'same-origin', cache: 'no-store', headers: {} };
    var prepare = method === 'GET' ? Promise.resolve() : getCsrf(retried).then(function (t) { opts.headers['x-csrf-token'] = t; });
    return prepare.then(function () {
      if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
      return fetch(path, opts);
    }).then(function (r) {
      return r.text().then(function (text) {
        var data = null, json = false;
        try { data = text ? JSON.parse(text) : null; json = text !== ''; } catch (e) { /* kein JSON */ }
        var res = { status: r.status, ok: r.ok, data: data, json: json };
        if (res.status === 403 && data && data.error === 'csrf_invalid' && !retried) return api(method, path, body, true);
        return res;
      });
    });
  }

  // ---------- Seitenrahmen ----------------------------------------------------------
  function page() { return document.getElementById('seite'); }
  function heading(title, intro) {
    document.title = title + ' – ' + (T.title || 'Portal');
    var k = el('div', 'seitenkopf');
    k.appendChild(el('h2', '', title));
    if (intro) k.appendChild(el('p', 'leise', intro));
    return k;
  }
  function card(title) {
    var c = el('section', 'flaeche');
    if (title) c.appendChild(el('h3', '', title));
    return c;
  }

  // ---------- Formulare ---------------------------------------------------------------
  var uid = 0;
  // field('Label', { type, autocomplete, ... }, 'Hinweis') -> { wrap, input }
  function field(label, attrs, hint) {
    var id = 'f' + (++uid);
    var wrap = el('div', 'feld');
    var l = el('label', '', label); l.setAttribute('for', id);
    var input = document.createElement('input');
    input.id = id; input.className = 'eingabe';
    Object.keys(attrs || {}).forEach(function (k) { input.setAttribute(k, attrs[k]); });
    wrap.appendChild(l); wrap.appendChild(input);
    if (hint) {
      var h = el('p', 'hinweis-klein', hint); h.id = id + '-h';
      input.setAttribute('aria-describedby', h.id);
      wrap.appendChild(h);
    }
    return { wrap: wrap, input: input };
  }
  function button(text, cls, onClick) {
    var b = el('button', 'knopf ' + (cls || ''), text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function submitButton(text, cls) {
    var b = el('button', 'knopf ' + (cls || ''), text); b.type = 'submit'; return b;
  }
  // Meldung (role=alert bei Fehlern, status sonst); `box` wird geleert und gefüllt.
  function message(box, kind, text) {
    clear(box);
    box.className = 'meldung' + (kind ? ' ' + kind : '');
    box.setAttribute('role', kind === 'fehler' ? 'alert' : 'status');
    if (!text) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('span', '', text));
  }
  function messageBox() { var b = el('div', 'meldung'); b.hidden = true; return b; }
  function busy(btn, on, text) {
    if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.setAttribute('aria-busy', 'true'); if (text) btn.textContent = text; }
    else { btn.disabled = false; btn.removeAttribute('aria-busy'); if (btn.dataset.label) btn.textContent = btn.dataset.label; }
  }

  function copyText(text, btn) {
    var done = function () {
      if (!btn) return;
      var old = btn.dataset.copyLabel || btn.textContent; btn.dataset.copyLabel = old;
      btn.textContent = T.copied || 'Copied';
      setTimeout(function () { btn.textContent = old; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
  }
  function codeBlock(text) {
    var wrap = el('div', 'codezeile');
    wrap.appendChild(el('code', '', text));
    var b = button(T.copy || 'Copy', 'zweit klein', function () { copyText(text, b); });
    wrap.appendChild(b);
    return wrap;
  }

  // Modaler Dialog: Passwort abfragen. Löst mit dem Passwort oder null (abgebrochen) auf.
  function askPassword() {
    return new Promise(function (resolve) {
      var d = document.createElement('dialog');
      d.className = 'dialog';
      var form = el('form', 'formular');
      form.appendChild(el('h3', '', T.askPasswordTitle));
      form.appendChild(el('p', 'leise', T.askPasswordHint));
      var f = field(T.password, { type: 'password', autocomplete: 'current-password', required: 'required' });
      form.appendChild(f.wrap);
      var row = el('div', 'zeile');
      var cancel = button(T.cancel, 'zweit', function () { d.close(); });
      row.appendChild(cancel); row.appendChild(submitButton(T.ok));
      form.appendChild(row);
      var result = null;
      form.addEventListener('submit', function (ev) { ev.preventDefault(); result = f.input.value; d.close(); });
      d.addEventListener('close', function () { d.remove(); resolve(result); });
      d.appendChild(form);
      document.body.appendChild(d);
      d.showModal();
      f.input.focus();
    });
  }
  function confirmDialog(text) {
    return new Promise(function (resolve) {
      var d = document.createElement('dialog');
      d.className = 'dialog';
      var form = el('form', 'formular');
      form.appendChild(el('p', '', text));
      var row = el('div', 'zeile');
      row.appendChild(button(T.cancel, 'zweit', function () { d.close(); }));
      row.appendChild(submitButton(T.ok));
      form.appendChild(row);
      var result = false;
      form.addEventListener('submit', function (ev) { ev.preventDefault(); result = true; d.close(); });
      d.addEventListener('close', function () { d.remove(); resolve(result); });
      d.appendChild(form);
      document.body.appendChild(d);
      d.showModal();
    });
  }

  // ---------- Passkeys (WebAuthn JSON <-> Browser-Objekte) --------------------------------
  function b64uToBuf(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a.buffer;
  }
  function bufToB64u(buf) {
    var a = new Uint8Array(buf), s = '';
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function creationOptions(o) {
    o.challenge = b64uToBuf(o.challenge);
    o.user.id = b64uToBuf(o.user.id);
    (o.excludeCredentials || []).forEach(function (c) { c.id = b64uToBuf(c.id); });
    return o;
  }
  function requestOptions(o) {
    o.challenge = b64uToBuf(o.challenge);
    (o.allowCredentials || []).forEach(function (c) { c.id = b64uToBuf(c.id); });
    return o;
  }
  function credentialJson(cred) {
    var r = cred.response;
    var out = {
      id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      response: { clientDataJSON: bufToB64u(r.clientDataJSON) }
    };
    if (cred.authenticatorAttachment) out.authenticatorAttachment = cred.authenticatorAttachment;
    if (r.attestationObject) {
      out.response.attestationObject = bufToB64u(r.attestationObject);
      out.response.transports = r.getTransports ? r.getTransports() : [];
    } else {
      out.response.authenticatorData = bufToB64u(r.authenticatorData);
      out.response.signature = bufToB64u(r.signature);
      if (r.userHandle) out.response.userHandle = bufToB64u(r.userHandle);
    }
    return out;
  }
  var passkeysSupported = !!(window.PublicKeyCredential && navigator.credentials);

  window.Portal = {
    T: T, icon: icon, el: el, clear: clear, fmt: fmt, dateText: dateText, api: api,
    page: page, heading: heading, card: card, field: field, button: button, submitButton: submitButton,
    message: message, messageBox: messageBox, busy: busy, codeBlock: codeBlock, copyText: copyText,
    askPassword: askPassword, confirmDialog: confirmDialog,
    passkeys: { supported: passkeysSupported, creationOptions: creationOptions, requestOptions: requestOptions, credentialJson: credentialJson }
  };
})();
