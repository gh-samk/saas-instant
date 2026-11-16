// Seiten des Portals: Anmeldung, Einrichtung, Mein Konto, Konten und Zugriffe.
(function () {
  'use strict';
  var P = window.Portal, T = P.T, el = P.el;

  // Nach der Anmeldung nur an bekannte Ziele des Portals weiterleiten.
  function safeNext(next) {
    if (next === '/') return '/';
    if (typeof next === 'string' && /^\/oauth\/authorize\/continue\?req=[0-9a-f-]{36}$/.test(next)) return next;
    return '/';
  }
  function roleLabel(role) { return role === 'admin' ? T.roleAdmin : role === 'staff' ? T.roleStaff : T.roleNone; }

  function loginError(res) {
    var e = res.data && res.data.error;
    if (e === 'account_locked') return P.fmt(T.errLocked, { minutes: Math.max(1, Math.ceil(((res.data && res.data.retryAfterSeconds) || 60) / 60)) });
    if (e === 'code_required') return T.errCodeRequired;
    if (e === 'setup_required') return T.errSetupRequired;
    if (e === 'rate_limited' || res.status === 429) return T.errRate;
    if (e === 'step_up_wrong_account') return T.errWrongAccount;
    if (e === 'auth_request_expired') return T.errExpired;
    if (res.status === 401) return T.errInvalid;
    return T.errGeneric;
  }

  // ---------- Anmeldung ----------------------------------------------------------------
  function login(ctx) {
    var params = new URLSearchParams(location.search);
    var req = params.get('req');
    var stepup = params.get('stepup') === '1';
    var root = P.page();
    if (ctx.me && !stepup) { location.replace(req ? '/oauth/authorize/continue?req=' + encodeURIComponent(req) : '/'); return; }
    root.appendChild(P.heading(stepup ? T.stepupTitle : T.loginTitle, stepup ? T.stepupIntro : T.loginIntro));

    var c = P.card();
    var form = el('form', 'formular'); form.noValidate = false;
    var email = P.field(T.email, { type: 'email', autocomplete: 'username', required: 'required', autofocus: 'autofocus' });
    if (ctx.me) { email.input.value = ctx.me.account.email; email.input.readOnly = true; }
    var pw = P.field(T.password, { type: 'password', autocomplete: 'current-password', required: 'required' });
    var code = P.field(T.code, { type: 'text', inputmode: 'text', autocomplete: 'one-time-code', required: 'required', autocapitalize: 'off', spellcheck: 'false' }, T.codeHint);
    var msg = P.messageBox();
    var submit = P.submitButton(stepup ? T.confirm : T.login, 'voll');
    [email.wrap, pw.wrap, code.wrap, msg, submit].forEach(function (n) { form.appendChild(n); });

    function done(res) {
      if (res.ok) { location.assign(safeNext(res.data && res.data.next)); return true; }
      P.message(msg, 'fehler', loginError(res));
      return false;
    }
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      P.message(msg, '', '');
      P.busy(submit, true, T.loginBusy);
      P.api('POST', '/api/auth/login', { email: email.input.value, password: pw.input.value, code: code.input.value, req: req || undefined })
        .then(function (res) { if (!done(res)) { pw.input.value = ''; code.input.value = ''; P.busy(submit, false); } })
        .catch(function () { P.message(msg, 'fehler', T.errGeneric); P.busy(submit, false); });
    });
    c.appendChild(form);

    if (P.passkeys.supported) {
      c.appendChild(el('p', 'trenner', T.or));
      var pk = P.button(T.passkeyLogin, 'zweit voll', function () {
        P.message(msg, '', '');
        P.busy(pk, true);
        P.api('POST', '/api/auth/passkey/options', {})
          .then(function (opt) {
            if (!opt.ok) throw new Error('options');
            return navigator.credentials.get({ publicKey: P.passkeys.requestOptions(opt.data) });
          })
          .then(function (cred) { return P.api('POST', '/api/auth/passkey/login', { response: P.passkeys.credentialJson(cred), req: req || undefined }); })
          .then(function (res) { if (res.ok) done(res); else { P.message(msg, 'fehler', res.status === 401 ? T.errPasskey : loginError(res)); P.busy(pk, false); } })
          .catch(function () { P.message(msg, 'fehler', T.errPasskey); P.busy(pk, false); });
      });
      c.appendChild(pk);
    }
    root.appendChild(c);
  }

  // ---------- Wiederherstellungscodes anzeigen ---------------------------------------------
  function showRecovery(root, codes, intro, onDone) {
    P.clear(root);
    var c = P.card(T.recoveryTitle);
    c.appendChild(el('p', 'leise', intro || T.recoveryHint));
    var list = el('ul', 'codeliste');
    codes.forEach(function (x) { var li = el('li'); li.appendChild(el('code', '', x)); list.appendChild(li); });
    c.appendChild(list);
    var row = el('div', 'zeile');
    var cp = P.button(T.copy, 'zweit', function () { P.copyText(codes.join('\n'), cp); });
    row.appendChild(cp);
    row.appendChild(P.button(T.recoveryDone, '', onDone));
    c.appendChild(row);
    root.appendChild(c);  }

  // ---------- Einrichtung per Link ---------------------------------------------------------
  function setup() {
    var root = P.page();
    var token = new URLSearchParams(location.search).get('token');
    function bad() { P.clear(root); root.appendChild(P.heading(T.setupTitle)); var m = P.messageBox(); P.message(m, 'fehler', T.setupLinkBad); root.appendChild(m); }
    if (!token) return bad();
    P.api('POST', '/api/auth/setup/begin', { token: token }).then(function (res) {
      if (!res.ok) return bad();
      var d = res.data, reset = d.purpose === 'reset';
      root.appendChild(P.heading(reset ? T.setupResetTitle : T.setupTitle, reset ? T.setupResetIntro : T.setupIntro));
      var holder = el('div');
      root.appendChild(holder);
      var c = P.card(T.setupStep1);
      c.appendChild(el('p', 'leise', T.setupStep1Hint));
      var qr = document.createElement('img');
      qr.className = 'qr'; qr.width = 220; qr.height = 220; qr.alt = ''; qr.src = d.qrDataUrl;
      c.appendChild(qr);
      c.appendChild(el('p', 'hinweis-klein', T.setupSecret));
      c.appendChild(P.codeBlock(d.totpSecret));
      holder.appendChild(c);

      var form = el('form', 'formular');
      var c2 = P.card(T.setupStep2);
      var em = P.field(T.email, { type: 'email', autocomplete: 'username', readonly: 'readonly' }); em.input.value = d.email;
      var pw = P.field(T.passwordNew, { type: 'password', autocomplete: 'new-password', required: 'required', minlength: '12' }, T.passwordHint);
      var pw2 = P.field(T.passwordRepeat, { type: 'password', autocomplete: 'new-password', required: 'required', minlength: '12' });
      var code = P.field(T.setupCode, { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', required: 'required', pattern: '[0-9 ]{6,7}', maxlength: '7' });
      var msg = P.messageBox();
      var submit = P.submitButton(T.setupFinish, 'voll');
      [em.wrap, pw.wrap, pw2.wrap, code.wrap, msg, submit].forEach(function (n) { c2.appendChild(n); });
      form.appendChild(c2);
      holder.appendChild(form);
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (pw.input.value !== pw2.input.value) return P.message(msg, 'fehler', T.mismatch);
        P.message(msg, '', ''); P.busy(submit, true, T.loginBusy);
        P.api('POST', '/api/auth/setup/complete', { token: token, password: pw.input.value, code: code.input.value }).then(function (r) {
          if (!r.ok) {
            P.busy(submit, false);
            var e = r.data && r.data.error;
            return P.message(msg, 'fehler', e === 'setup_link_invalid' ? T.setupLinkBad : (r.data && r.data.message) || T.errGeneric);
          }
          P.clear(root);
          document.title = T.recoveryTitle + ' – ' + (T.title || 'Portal');
          var box = el('div'); root.appendChild(box);
          showRecovery(box, r.data.recoveryCodes, null, function () { location.assign('/auth/login'); });
        }).catch(function () { P.busy(submit, false); P.message(msg, 'fehler', T.errGeneric); });
      });
    }).catch(function () { bad(); });
  }

  // ---------- Mein Konto ---------------------------------------------------------------------
  function account(ctx) {
    var root = P.page();
    var me = ctx.me;
    root.appendChild(P.heading(T.accountTitle, T.accountIntro));

    // Profil und Zugriffe
    var prof = P.card(T.profile);
    prof.appendChild(el('p', 'stark', me.account.name));
    prof.appendChild(el('p', 'leise', me.account.email));
    var slugs = Object.keys(me.roles);
    prof.appendChild(el('h4', '', T.yourAccess));
    if (!slugs.length) prof.appendChild(el('p', 'leise', T.noAccessShort));
    else {
      var chips = el('ul', 'chips');
      slugs.forEach(function (s) { chips.appendChild(el('li', 'chip', s + ': ' + roleLabel(me.roles[s]))); });
      prof.appendChild(chips);
    }
    root.appendChild(prof);

    // Passwort
    var pwCard = P.card(T.pwSection);
    var pwForm = el('form', 'formular');
    var cur = P.field(T.pwCurrent, { type: 'password', autocomplete: 'current-password', required: 'required' });
    var n1 = P.field(T.passwordNew, { type: 'password', autocomplete: 'new-password', required: 'required', minlength: '12' }, T.passwordHint);
    var n2 = P.field(T.passwordRepeat, { type: 'password', autocomplete: 'new-password', required: 'required', minlength: '12' });
    var pwMsg = P.messageBox(), pwBtn = P.submitButton(T.pwSave);
    [cur.wrap, n1.wrap, n2.wrap, pwMsg, pwBtn].forEach(function (n) { pwForm.appendChild(n); });
    pwForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (n1.input.value !== n2.input.value) return P.message(pwMsg, 'fehler', T.mismatch);
      P.busy(pwBtn, true);
      P.api('POST', '/api/me/password', { currentPassword: cur.input.value, newPassword: n1.input.value }).then(function (r) {
        P.busy(pwBtn, false);
        if (r.ok) { pwForm.reset(); return P.message(pwMsg, 'erfolg', T.pwChanged); }
        P.message(pwMsg, 'fehler', r.data && r.data.error === 'password_wrong' ? T.errPasswordWrong : (r.data && r.data.message) || T.errGeneric);
      }).catch(function () { P.busy(pwBtn, false); P.message(pwMsg, 'fehler', T.errGeneric); });
    });
    pwCard.appendChild(pwForm);
    root.appendChild(pwCard);

    // Authenticator-App
    var totpCard = P.card(T.totpSection);
    totpCard.appendChild(el('p', 'leise', T.totpHint));
    var totpBody = el('div');
    var totpMsg = P.messageBox();
    var renew = P.button(T.totpRenew, 'zweit', function () {
      P.askPassword().then(function (password) {
        if (password === null) return;
        return P.api('POST', '/api/me/totp/begin', { password: password }).then(function (r) {
          if (!r.ok) return P.message(totpMsg, 'fehler', r.data && r.data.error === 'password_wrong' ? T.errPasswordWrong : T.errGeneric);
          P.message(totpMsg, '', '');
          P.clear(totpBody);
          var img = document.createElement('img'); img.className = 'qr'; img.width = 220; img.height = 220; img.alt = ''; img.src = r.data.qrDataUrl;
          totpBody.appendChild(img);
          totpBody.appendChild(P.codeBlock(r.data.totpSecret));
          var f = el('form', 'formular');
          var code = P.field(T.setupCode, { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', required: 'required', maxlength: '7' });
          var b = P.submitButton(T.totpConfirm);
          f.appendChild(code.wrap); f.appendChild(b);
          f.addEventListener('submit', function (ev) {
            ev.preventDefault();
            P.busy(b, true);
            P.api('POST', '/api/me/totp/confirm', { code: code.input.value }).then(function (c) {
              P.busy(b, false);
              if (!c.ok) return P.message(totpMsg, 'fehler', (c.data && c.data.message) || T.errGeneric);
              P.message(totpMsg, '', '');
              showRecovery(totpBody, c.data.recoveryCodes, T.totpReplaced, function () { location.reload(); });
            });
          });
          totpBody.appendChild(f);
        });
      });
    });
    totpCard.appendChild(totpMsg); totpCard.appendChild(totpBody); totpCard.appendChild(renew);
    root.appendChild(totpCard);

    // Wiederherstellungscodes
    var recCard = P.card(T.recoverySection);
    recCard.appendChild(el('p', 'leise', P.fmt(T.recoveryLeft, { n: me.factors.recoveryCodesLeft })));
    var recBody = el('div'), recMsg = P.messageBox();
    var recBtn = P.button(T.recoveryNew, 'zweit', function () {
      P.askPassword().then(function (password) {
        if (password === null) return;
        return P.api('POST', '/api/me/recovery-codes', { password: password }).then(function (r) {
          if (!r.ok) return P.message(recMsg, 'fehler', r.data && r.data.error === 'password_wrong' ? T.errPasswordWrong : T.errGeneric);
          P.message(recMsg, '', '');
          showRecovery(recBody, r.data.recoveryCodes, null, function () { location.reload(); });
          recBtn.hidden = true;
        });
      });
    });
    recCard.appendChild(recMsg); recCard.appendChild(recBody); recCard.appendChild(recBtn);
    root.appendChild(recCard);

    // Passkeys
    var pkCard = P.card(T.passkeySection);
    pkCard.appendChild(el('p', 'leise', T.passkeyHint));
    var pkMsg = P.messageBox();
    pkCard.appendChild(pkMsg);
    var pks = me.factors.passkeys;
    if (!pks.length) pkCard.appendChild(el('p', 'leise', T.passkeyNone));
    else {
      var ul = el('ul', 'liste-zeilen');
      pks.forEach(function (k) {
        var li = el('li');
        var t = el('div', 'text');
        t.appendChild(el('span', 'stark', k.label));
        t.appendChild(el('span', 'leise klein', k.lastUsedAt ? P.fmt(T.passkeyLastUsed, { date: P.dateText(k.lastUsedAt) }) : T.passkeyNeverUsed));
        li.appendChild(t);
        li.appendChild(P.button(T.passkeyRemove, 'zweit klein', function () {
          P.askPassword().then(function (password) {
            if (password === null) return;
            return P.api('POST', '/api/me/passkeys/' + k.id + '/delete', { password: password }).then(function (r) {
              if (r.ok) location.reload();
              else P.message(pkMsg, 'fehler', r.data && r.data.error === 'password_wrong' ? T.errPasswordWrong : T.errGeneric);
            });
          });
        }));
        ul.appendChild(li);
      });
      pkCard.appendChild(ul);
    }
    if (!P.passkeys.supported) pkCard.appendChild(el('p', 'leise', T.passkeyUnsupported));
    else {
      var add = P.button(T.passkeyAdd, 'zweit', function () {
        P.askPassword().then(function (password) {
          if (password === null) return;
          P.message(pkMsg, '', '');
          return P.api('POST', '/api/me/passkeys/options', { password: password }).then(function (opt) {
            if (!opt.ok) throw new Error(opt.data && opt.data.error === 'password_wrong' ? 'pw' : 'opt');
            return navigator.credentials.create({ publicKey: P.passkeys.creationOptions(opt.data) });
          }).then(function (cred) {
            return P.api('POST', '/api/me/passkeys', { response: P.passkeys.credentialJson(cred), label: T.passkeyLabelDefault });
          }).then(function (r) {
            if (r.ok) location.reload(); else P.message(pkMsg, 'fehler', T.errPasskey);
          }).catch(function (e) { P.message(pkMsg, 'fehler', e && e.message === 'pw' ? T.errPasswordWrong : T.errPasskey); });
        });
      });
      pkCard.appendChild(add);
    }
    root.appendChild(pkCard);
  }

  // ---------- Konten und Zugriffe --------------------------------------------------------------
  function admin(ctx) {
    var root = P.page();
    if (!ctx.me.account.portalAdmin) {
      root.appendChild(P.heading(T.forbiddenTitle));
      var m = P.messageBox(); P.message(m, 'fehler', T.forbiddenHint); root.appendChild(m);
      return;
    }
    root.appendChild(P.heading(T.adminTitle, T.adminIntro));
    var status = P.messageBox();
    root.appendChild(status);
    var linkBox = el('div'); root.appendChild(linkBox);

    // Konto anlegen
    var cNew = P.card(T.newAccount);
    var form = el('form', 'formular zeilen');
    var nName = P.field(T.newName, { type: 'text', required: 'required', maxlength: '120', autocomplete: 'off' });
    var nMail = P.field(T.email, { type: 'email', required: 'required', maxlength: '254', autocomplete: 'off' });
    var nAdminWrap = el('label', 'haken');
    var nAdmin = document.createElement('input'); nAdmin.type = 'checkbox';
    nAdminWrap.appendChild(nAdmin); nAdminWrap.appendChild(el('span', '', T.newPortalAdmin));
    var nBtn = P.submitButton(T.newCreate);
    [nName.wrap, nMail.wrap, nAdminWrap, nBtn].forEach(function (n) { form.appendChild(n); });
    cNew.appendChild(form);
    root.appendChild(cNew);

    var listHolder = el('div'); root.appendChild(listHolder);
    var clients = [];

    function showLink(email, link, intro) {
      P.clear(linkBox);
      var c = P.card(P.fmt(T.linkTitle, { email: email }));
      c.appendChild(el('p', 'leise', intro || T.newResult));
      c.appendChild(P.codeBlock(link));
      c.setAttribute('role', 'status');
      linkBox.appendChild(c);
      c.scrollIntoView({ block: 'nearest' });
    }
    function fail(res) { P.message(status, 'fehler', (res.data && res.data.message) || T.errGeneric); }
    function act(path, body, then) {
      P.message(status, '', '');
      return P.api('POST', path, body || {}).then(function (r) { if (!r.ok) return fail(r); if (then) then(r); return load(); }).catch(function () { P.message(status, 'fehler', T.errGeneric); });
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      P.busy(nBtn, true);
      P.api('POST', '/api/admin/accounts', { name: nName.input.value, email: nMail.input.value, portalAdmin: nAdmin.checked }).then(function (r) {
        P.busy(nBtn, false);
        if (!r.ok) return fail(r);
        form.reset();
        showLink(r.data.account.email, r.data.setupLink);
        load();
      }).catch(function () { P.busy(nBtn, false); P.message(status, 'fehler', T.errGeneric); });
    });

    function statusChips(a) {
      var ul = el('ul', 'chips');
      if (a.disabled) ul.appendChild(el('li', 'chip gefahr', T.statusDisabled));
      else if (a.setupPending) ul.appendChild(el('li', 'chip warnung', T.statusSetup));
      else ul.appendChild(el('li', 'chip erfolg', T.statusActive));
      if (a.locked) ul.appendChild(el('li', 'chip warnung', T.statusLocked));
      if (a.portalAdmin) ul.appendChild(el('li', 'chip', T.statusAdmin));
      return ul;
    }

    function render(accounts) {
      P.clear(listHolder);
      var c = P.card(T.accountsList); c.classList.add('breit');
      if (!clients.length) c.appendChild(el('p', 'leise', T.adminNone));
      var wrap = el('div', 'tabelle');
      var table = el('table');
      var head = el('tr');
      [T.colAccount, T.colStatus].forEach(function (h) { head.appendChild(el('th', '', h)); });
      clients.forEach(function (cl) { head.appendChild(el('th', '', cl.name || cl.id)); });
      head.appendChild(el('th', '', T.colActions));
      var thead = el('thead'); thead.appendChild(head); table.appendChild(thead);
      var tbody = el('tbody');
      accounts.forEach(function (a) {
        var tr = el('tr');
        var td = el('td');
        td.appendChild(el('div', 'stark', a.name));
        td.appendChild(el('div', 'leise klein', a.email));
        td.appendChild(el('div', 'leise klein', T.lastLogin + ': ' + (a.lastLoginAt ? P.dateText(a.lastLoginAt) : T.never)));
        tr.appendChild(td);
        var ts = el('td'); ts.appendChild(statusChips(a)); tr.appendChild(ts);
        clients.forEach(function (cl) {
          var tc = el('td');
          var sel = el('select', 'auswahl');
          sel.setAttribute('aria-label', P.fmt(T.roleFor, { name: a.name, client: cl.name || cl.id }));
          [['none', T.roleNone], ['staff', T.roleStaff], ['admin', T.roleAdmin]].forEach(function (o) {
            var op = el('option', '', o[1]); op.value = o[0]; sel.appendChild(op);
          });
          sel.value = a.roles[cl.id] || 'none';
          sel.addEventListener('change', function () {
            act('/api/admin/accounts/' + a.id + '/roles', { clientId: cl.id, role: sel.value }, function () { P.message(status, 'erfolg', T.saved); });
          });
          tc.appendChild(sel); tr.appendChild(tc);
        });
        var ta = el('td'); var acts = el('div', 'aktionen');
        acts.appendChild(P.button(a.setupPending ? T.actLink : T.actLinkReset, 'zweit klein', function () {
          var go = function () { act('/api/admin/accounts/' + a.id + '/setup-link', {}, function (r) { showLink(a.email, r.data.setupLink); }); };
          if (a.setupPending) go(); else P.confirmDialog(P.fmt(T.confirmReset, { email: a.email })).then(function (y) { if (y) go(); });
        }));
        if (a.disabled) acts.appendChild(P.button(T.actEnable, 'zweit klein', function () { act('/api/admin/accounts/' + a.id + '/enable'); }));
        else acts.appendChild(P.button(T.actDisable, 'zweit klein', function () {
          P.confirmDialog(P.fmt(T.confirmDisable, { email: a.email })).then(function (y) { if (y) act('/api/admin/accounts/' + a.id + '/disable'); });
        }));
        if (a.locked) acts.appendChild(P.button(T.actUnlock, 'zweit klein', function () { act('/api/admin/accounts/' + a.id + '/unlock'); }));
        acts.appendChild(P.button(a.portalAdmin ? T.actDropAdmin : T.actMakeAdmin, 'zweit klein', function () {
          act('/api/admin/accounts/' + a.id + '/portal-admin', { value: !a.portalAdmin });
        }));
        ta.appendChild(acts); tr.appendChild(ta);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      c.appendChild(wrap);
      listHolder.appendChild(c);
    }

    function load() {
      return Promise.all([P.api('GET', '/api/admin/clients'), P.api('GET', '/api/admin/accounts')]).then(function (r) {
        if (!r[0].ok || !r[1].ok) return fail(r[0].ok ? r[1] : r[0]);
        clients = r[0].data.clients;
        render(r[1].data.accounts);
      }).catch(function () { P.message(status, 'fehler', T.errGeneric); });
    }
    load();
  }

  window.PortalViews = { login: login, setup: setup, account: account, admin: admin };
})();
