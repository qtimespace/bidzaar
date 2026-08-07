# syntax=docker/dockerfile:1.7
# ═══════════════════════════════════════════════════════════════════════════
# Bidzaar Exchange Order — один образ, три адреса.
#
#   /               прототип экрана обмена   (React 19 + Vite 6)
#   /docs/          вики                     (MkDocs Material)
#   /docs/swagger/  Swagger UI               (OpenAPI 3.1, 10 спецификаций)
#
# Четыре стадии. Первые три — тулчейн (Node, Python, node_modules),
# в финальный образ из них уезжает только содержимое dist/.
#
#   1   prototype-build   node    → prototype/dist
#   2a  portal-vendor     node    → node_modules портала (нужны 2 поддерева)
#   2b  portal-build      python  → portal/dist
#   3   runtime           nginx   → образ
#
# Python берётся официальным образом, а не доустанавливается в образ Node
# через apt: та стадия тянула около 150 МБ пакетов и была самым медленным
# и самым сетезависимым шагом всей сборки.
# ═══════════════════════════════════════════════════════════════════════════


# ───────────────────────────────────────────────────────────────────────────
# Стадия 1. Прототип: Node, статическая сборка Vite.
# ───────────────────────────────────────────────────────────────────────────
FROM node:22.17.1-bookworm-slim AS prototype-build

WORKDIR /build/prototype

# Зависимости отдельным слоем: он переживает правки в src/ и экономит
# минуту-полторы на каждой пересборке.
COPY prototype/package.json prototype/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY prototype/ ./

# `npm run build` = `tsc -b && vite build`, то есть проверка типов внутри.
# Скрипты verify:money / verify:render / verify:flow здесь СОЗНАТЕЛЬНО не
# запускаются: это три дополнительные SSR-сборки Vite поверх основной, они
# примерно утраивают время стадии и проверяют поведение приложения, а не
# собираемость артефакта. Их место — CI на pull request, где падение должно
# останавливать мердж, а не деплой уже принятого кода. Регресс типов при этом
# всё равно ловится: `tsc -b` остаётся частью build.
RUN npm run build \
 && test -f dist/index.html \
 && test -d dist/assets


# ───────────────────────────────────────────────────────────────────────────
# Стадия 2a. Вендоринг: только node_modules портала.
#
# Из всего дерева зависимостей порталу нужны ровно две вещи —
# swagger-ui-dist (офлайн Swagger UI) и mermaid.min.js (офлайн диаграммы).
# Их забирает следующая стадия; сам Node в сборке документации не участвует.
# ───────────────────────────────────────────────────────────────────────────
FROM node:22.17.1-bookworm-slim AS portal-vendor

WORKDIR /build/portal
COPY portal/package.json portal/package-lock.json ./
RUN npm ci --no-audit --no-fund


# ───────────────────────────────────────────────────────────────────────────
# Стадия 2b. Портал: MkDocs Material.
#
# Берём официальный образ Python, а НЕ образ Node с доустановкой python3
# через apt. Причина практическая: apt-стадия тянула около 150 МБ пакетов,
# была самым медленным и самым сетезависимым шагом всей сборки и требовала
# возни с venv из-за PEP 668 (externally-managed) в Debian 12. Здесь ничего
# этого нет: pip ставит в системный python образа штатно.
#
# Цена решения: node_modules приходится переносить между стадиями явным COPY,
# и если sync.py начнёт читать из node_modules что-то ещё, этот COPY придётся
# дополнить руками. Список читаемых путей — в sync.py, функция vendor_assets().
# ───────────────────────────────────────────────────────────────────────────
FROM python:3.12-slim-bookworm AS portal-build

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /build/portal

COPY portal/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
 && python -m mkdocs --version

# Ровно те два поддерева, которые читает vendor_assets(). Копировать
# node_modules целиком незачем: 14.6 МБ против сотен.
COPY --from=portal-vendor /build/portal/node_modules/swagger-ui-dist ./node_modules/swagger-ui-dist
COPY --from=portal-vendor /build/portal/node_modules/mermaid/dist/mermaid.min.js ./node_modules/mermaid/dist/mermaid.min.js

# Ключевой момент сборки портала: в контекст нужен ВЕСЬ репозиторий.
# portal/wiki/mkdocs.yml подключает исходные документы напрямую из корня
# через pymdownx.snippets (`--8<-- "docs/SDD.md"`, `--8<-- "promtlog.md"`)
# с base_path ../.. — копий этих файлов внутри portal/ не существует.
# Скопировать только portal/ = гарантированное падение mkdocs --strict.
WORKDIR /build
COPY . ./

# node_modules исключён в .dockerignore, поэтому COPY . ./ выше не затирает
# вендоринг. Проверяем это явно: иначе поломка всплыла бы поздно и невнятно —
# mermaid молча заменился бы заглушкой, а диаграммы ушли бы на CDN.
RUN test -f portal/node_modules/mermaid/dist/mermaid.min.js \
 && test -d portal/node_modules/swagger-ui-dist

# site_url нужен ровно для одного файла — 404.html. MkDocs строит все обычные
# страницы на относительных ссылках (работают на любой глубине монтирования),
# но 404-ю — на абсолютных, взятых из пути site_url. Без site_url там окажется
# /assets/…, то есть каталог ассетов ПРОТОТИПА, и страница «не найдено»
# сама приедет сломанной. Значение по умолчанию даёт правильный путь /docs/
# при любом домене; подставить реальный домен стоит только ради канонических
# ссылок и sitemap.xml:
#   docker build --build-arg PORTAL_SITE_URL=https://<app>.up.railway.app/docs/ .
ARG PORTAL_SITE_URL=http://localhost:8080/docs/
ENV PORTAL_SITE_URL=$PORTAL_SITE_URL

# Здесь НЕ `npm run build`: npm в этом образе нет. Тот скрипт — это ровно две
# команды ниже, и они обязаны оставаться синхронными с portal/package.json.
# --strict превращает любое предупреждение (битая ссылка, потерянный сниппет)
# в ненулевой код возврата, то есть в упавшую сборку образа. Это то, что нужно.
RUN cd portal \
 && python tools/sync.py \
 && python -m mkdocs build --strict --clean --config-file wiki/mkdocs.yml \
 && test -f dist/index.html \
 && test -f dist/swagger/index.html \
 && test -f dist/swagger/specs/exchange-orders.openapi.yaml \
 && test -f dist/swagger/vendor/swagger-ui-bundle.js


# ───────────────────────────────────────────────────────────────────────────
# Стадия 3. Рантайм: nginx + статика. Ни Node, ни Python, ни node_modules.
# ───────────────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Раскладка файлов повторяет раскладку URL — см. комментарий в шаблоне конфига.
RUN rm -rf /usr/share/nginx/html && mkdir -p /srv/www

COPY --from=prototype-build /build/prototype/dist/ /srv/www/
COPY --from=portal-build    /build/portal/dist/    /srv/www/docs/

# Шаблон лежит НЕ в /etc/nginx/templates/: туда смотрит штатный скрипт
# 20-envsubst-on-templates.sh, который подставил бы вообще все переменные
# окружения, включая nginx'овые $uri и $host.
COPY deploy/nginx/default.conf.template /etc/nginx/bidzaar/default.conf.template
COPY deploy/nginx/40-render-port.sh     /docker-entrypoint.d/40-render-port.sh
# sed — страховка от CRLF: репозиторий разрабатывается на Windows с
# core.autocrlf=true, а `#!/bin/sh` с \r в конце строки даёт в контейнере
# «bad interpreter». .gitattributes это уже закрывает, но стоит одну строку.
RUN sed -i 's/\r$//' /docker-entrypoint.d/40-render-port.sh \
                     /etc/nginx/bidzaar/default.conf.template \
 && chmod +x /docker-entrypoint.d/40-render-port.sh \
 && rm -f /etc/nginx/conf.d/default.conf

# Значение по умолчанию для локального запуска; на Railway PORT приходит извне.
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

# ENTRYPOINT и CMD — штатные для образа nginx:
#   ENTRYPOINT ["/docker-entrypoint.sh"]
#   CMD ["nginx", "-g", "daemon off;"]
# /docker-entrypoint.sh прогоняет /docker-entrypoint.d/*.sh (в том числе наш
# 40-render-port.sh) и только потом отдаёт управление nginx.
