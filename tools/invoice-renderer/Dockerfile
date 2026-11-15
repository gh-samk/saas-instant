# saas-instant invoice renderer: creates PDF/A-3b with embedded ZUGFeRD XML.
# Rechnungsdienst: erzeugt PDF/A-3b mit eingebettetem ZUGFeRD-XML.
#
# The image holds three things: a browser that lays out the visible document,
# Mustangproject, which turns it into PDF/A-3 with attachment and validates the
# result, and a small Java program that connects both (src/java/InvoiceService.java).
#
# Build / Bau (Kontext = dieses Verzeichnis):
#   docker build -t saas-instant-invoice-renderer tools/invoice-renderer
#
# Run hardened / gehaertet starten (kein Netzzugang noetig, siehe README.md):
#   docker run --rm --read-only --tmpfs /tmp:size=256m --cap-drop ALL \
#     --security-opt no-new-privileges:true -p 127.0.0.1:8080:8080 saas-instant-invoice-renderer
#
# BASE is a build argument. Default: debian:bookworm-slim.
ARG BASIS=debian:bookworm-slim

# ---------------------------------------------------------------- Bau ------
FROM ${BASIS} AS bau
ARG MUSTANG_VERSION=2.17.0
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-17-jdk-headless ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
# Mustangproject steht unter Apache 2.0 und bringt veraPDF als Bibliothek mit.
# Deshalb braucht der Dienst weder einen zweiten Pruefer noch Ghostscript
# (das unter AGPL steht und fuer den Einsatz in einem verkauften Dienst eine
# gesonderte Lizenz von Artifex verlangen wuerde).
RUN curl -fsSL -o /opt/mustang-cli.jar \
      "https://repo1.maven.org/maven2/org/mustangproject/Mustang-CLI/${MUSTANG_VERSION}/Mustang-CLI-${MUSTANG_VERSION}.jar"
COPY src/java/InvoiceService.java /bau/
RUN mkdir -p /opt/dienst && javac -nowarn -encoding UTF-8 -cp /opt/mustang-cli.jar -d /opt/dienst /bau/InvoiceService.java

# ------------------------------------------------------------- Betrieb -----
FROM ${BASIS} AS lauf
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-17-jre-headless \
      chromium \
      fonts-dejavu-core \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Inter (variable font, SIL OFL 1.1, licence text in fonts/OFL.txt): the font of
# the invoice design. Chromium embeds the subset it uses into the PDF.
COPY fonts/InterVariable.ttf fonts/OFL.txt /usr/share/fonts/truetype/inter/
RUN fc-cache -f

COPY --from=bau /opt/mustang-cli.jar /opt/mustang-cli.jar
COPY --from=bau /opt/dienst /opt/dienst

# Chromium laeuft im Container ohne eigene Sandbox (--no-sandbox): Die Sandbox
# braucht unprivilegierte User-Namespaces, die Dockers Standardprofil und
# cap_drop ALL sperren. Ausgleich: unprivilegierter Benutzer mit fester UID
# (kein root, keine Login-Shell), gekappte Namensaufloesung im Browser,
# schreibgeschuetztes Wurzeldateisystem im Betrieb. Wer die Sandbox nutzen kann,
# setzt RECHNUNG_BROWSER_SANDBOX=1 (siehe README.md).
RUN useradd --system --uid 10001 --user-group --create-home \
      --home-dir /home/rechnung --shell /usr/sbin/nologin rechnung
USER 10001:10001
WORKDIR /home/rechnung

ENV RECHNUNG_PORT=8080 \
    RECHNUNG_BROWSER=/usr/bin/chromium \
    RECHNUNG_SELBSTPRUEFUNG=1

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=25s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${RECHNUNG_PORT}/gesundheit" || exit 1

CMD ["sh", "-c", "exec java -cp /opt/mustang-cli.jar:/opt/dienst InvoiceService dienst ${RECHNUNG_PORT}"]
