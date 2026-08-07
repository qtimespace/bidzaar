# Как запустить

## Портал документации

Все команды выполняются из каталога `portal/` (PowerShell, Windows).

=== "Режим разработки (два адреса)"

    ```powershell
    cd portal
    npm run wiki    # http://127.0.0.1:8100/  — эта вики
    npm run api     # http://127.0.0.1:8101/  — Swagger UI
    ```

    Каждая команда занимает свой терминал: `mkdocs serve` следит за изменениями,
    статический сервер Swagger UI работает отдельно.

=== "Сборка и раздача"

    ```powershell
    cd portal
    npm run build   # → portal/dist/
    npm run serve   # http://127.0.0.1:8080/         — вики
                    # http://127.0.0.1:8080/swagger/ — Swagger UI
    ```

    В собранном виде это один статический каталог: вики в корне, Swagger UI
    в подпапке `swagger/`. Ссылки между ними относительные, поэтому сайт
    переносится под любой домен и любой префикс пути.

!!! note "Требования"

    Python с `mkdocs` 1.6 и `mkdocs-material` 9.7 (`python -m mkdocs --version`),
    Node.js — только чтобы запускать npm-скрипты и один раз подтянуть
    `swagger-ui-dist` и `mermaid` в `portal/node_modules/`.

## Прототип экрана обмена

```powershell
cd prototype
npm install
npm run dev          # http://localhost:5173
```

Данные захардкожены, авторизации нет, сети нет — по требованию заказчика фокус
на экране обмена. Слой `src/api/` имитирует BFF и все девять внешних сервисов.

## Проверка консистентности документов

```powershell
node tools/verify-docs.mjs
```

97 автоматических сверок между документами и кодом прототипа.
