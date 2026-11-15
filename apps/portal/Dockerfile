# nginx-STABLE-Zweig (gerade Minor-Nummer), Patch-Version festgelegt. 1.27 ist
# ein auslaufender Mainline-Zweig ohne Sicherheitskorrekturen mehr.
# Beim Anheben: https://nginx.org/en/CHANGES-1.30 und die Tags von
# nginxinc/nginx-unprivileged prüfen.
FROM nginxinc/nginx-unprivileged:1.30.6-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/portal/security-headers.conf
COPY index.html tokens.css style.css app.js strings.de.js /usr/share/nginx/html/
COPY fonts/ /usr/share/nginx/html/fonts/
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
