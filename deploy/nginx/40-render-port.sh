#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# Подстановка $PORT в конфигурацию nginx на старте контейнера.
#
# Почему на старте, а не на сборке: Railway выдаёт порт переменной окружения
# и может сменить его между деплоями. Захардкоженный `listen 80` — самый
# частый способ получить «Application failed to respond».
#
# Почему свой скрипт, а не штатный /docker-entrypoint.d/20-envsubst-on-templates.sh:
# штатный подставляет ВСЕ переменные окружения, включая $uri и $host из
# конфига nginx (ограничить можно только регуляркой NGINX_ENVSUBST_FILTER).
# Здесь список подставляемых переменных задан явно — промахнуться нечем.
#
# Скрипт запускает /docker-entrypoint.sh официального образа nginx:
# он выполняет все исполняемые *.sh из /docker-entrypoint.d/ до запуска nginx.
# ═══════════════════════════════════════════════════════════════════════════
set -eu

: "${PORT:=8080}"
export PORT

# IPv6 добавляем, только если ядро контейнера его поддерживает.
if [ -f /proc/net/if_inet6 ]; then
    LISTEN_IPV6="    listen [::]:${PORT} default_server ipv6only=on;"
else
    LISTEN_IPV6=""
fi
export LISTEN_IPV6

TEMPLATE=/etc/nginx/bidzaar/default.conf.template
OUTPUT=/etc/nginx/conf.d/default.conf

if [ ! -f "$TEMPLATE" ]; then
    echo "40-render-port.sh: нет шаблона $TEMPLATE" >&2
    exit 1
fi

envsubst '${PORT} ${LISTEN_IPV6}' < "$TEMPLATE" > "$OUTPUT"

echo "40-render-port.sh: конфигурация собрана, nginx слушает порт ${PORT}" \
     "${LISTEN_IPV6:+(+IPv6)}"
