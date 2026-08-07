# Деплой на Railway

Весь проект — один Docker-образ со статикой и nginx внутри. Ни базы, ни
бэкенда, ни секретов: прототип работает на захардкоженных данных, портал —
это заранее собранные HTML.

| Адрес | Что отдаётся | Откуда в образе |
|-------|--------------|-----------------|
| `/` | прототип экрана обмена (React 19 + Vite 6) | `/srv/www/` |
| `/docs/` | вики (MkDocs Material) | `/srv/www/docs/` |
| `/docs/swagger/` | Swagger UI, 10 спецификаций OpenAPI 3.1 | `/srv/www/docs/swagger/` |
| `/healthz` | `200 ok` — health-check Railway | генерируется nginx в памяти |

---

## 1. Что нужно до начала

* Аккаунт на [railway.com](https://railway.com) (бесплатного плана достаточно).
* Установленный Railway CLI — только для варианта «через CLI»:

  ```bash
  npm i -g @railway/cli     # или: brew install railway
  railway --version
  railway login
  ```

Docker локально **не требуется**: образ собирает Railway.

---

## 2. Вариант А — подключение репозитория (рекомендуется)

Автодеплой на каждый push, откат в один клик.

1. Запушьте ветку в GitHub.
2. Railway → **New Project** → **Deploy from GitHub repo** → выберите репозиторий.
3. Railway найдёт в корне `railway.json`, увидит `"builder": "DOCKERFILE"` и
   соберёт корневой `Dockerfile`. Никаких настроек билдера руками задавать
   не нужно — Nixpacks не подключается.
4. Дождитесь статуса **Deployed** и зелёного health-check.
5. Вкладка **Settings → Networking → Public Networking** → **Generate Domain**.
   Порт указывать не нужно: контейнер слушает `$PORT`, который Railway
   подставляет сам.

## 3. Вариант Б — через CLI

Из корня репозитория (`d:\Project\bidzaar`):

```bash
railway login                       # откроет браузер
railway init                        # создать проект; спросит имя
railway up                          # загрузить контекст и собрать образ
railway domain                      # выдать публичный домен
railway open                        # открыть проект в браузере
```

Полезное рядом:

```bash
railway logs                        # логи сборки и рантайма
railway logs --deployment           # логи только текущего деплоя
railway status                      # что сейчас задеплоено
railway variables                   # список переменных окружения
```

Повторный деплой той же командой `railway up`.

---

## 4. Переменные окружения

Обязательных нет. Приложение стартует «из коробки».

| Переменная | Кто задаёт | Зачем |
|------------|-----------|-------|
| `PORT` | **Railway, автоматически** | Порт, который слушает nginx. Задавать вручную не нужно и вредно. В образе есть значение по умолчанию `8080` — только для локального запуска. |

### Необязательный build-arg

| Аргумент сборки | По умолчанию | Зачем |
|-----------------|--------------|-------|
| `PORTAL_SITE_URL` | `http://localhost:8080/docs/` | Абсолютный адрес вики. Влияет ровно на две вещи: `rel="canonical"` на страницах и `sitemap.xml`. На работоспособность ссылок **не влияет** — путь `/docs/` в значении по умолчанию уже правильный. |

Если хочется корректных канонических ссылок, после получения домена задайте
в **Settings → Variables** сервиса:

```
PORTAL_SITE_URL = https://<ваш-домен>.up.railway.app/docs/
```

Railway пробрасывает переменные сервиса в сборку как build-args, и
`Dockerfile` их подхватывает (`ARG PORTAL_SITE_URL`). После добавления
переменной нужен **Redeploy**, потому что значение вшивается в HTML на этапе
сборки.

---

## 5. Как убедиться, что деплой удался

Замените `<домен>` на выданный Railway адрес.

```bash
# 1. Health-check — должен быть 200 и тело "ok"
curl -i https://<домен>/healthz

# 2. Прототип
curl -o /dev/null -s -w "%{http_code}\n" https://<домен>/

# 3. Вики
curl -o /dev/null -s -w "%{http_code}\n" https://<домен>/docs/
curl -o /dev/null -s -w "%{http_code}\n" https://<домен>/docs/sdd/

# 4. Swagger UI и спецификация, которую он грузит
curl -o /dev/null -s -w "%{http_code}\n" https://<домен>/docs/swagger/index.html
curl -o /dev/null -s -w "%{http_code}\n" https://<домен>/docs/swagger/specs/exchange-orders.openapi.yaml

# 5. Адрес без завершающего слэша обязан отдать 301, а не 200
curl -o /dev/null -s -w "%{http_code} -> %{redirect_url}\n" https://<домен>/docs

# 6. Несуществующая страница под /docs/ обязана отдать 404, а не index прототипа
curl -o /dev/null -s -w "%{http_code}\n" https://<домен>/docs/нет-такой-страницы/

# 7. Неизвестный путь под / обязан отдать 200 (SPA-fallback)
curl -o /dev/null -s -w "%{http_code}\n" https://<домен>/какой-угодно-путь
```

Ожидаемое: `200, 200, 200, 200, 200, 200, 301 -> /docs/, 404, 200`.

В PowerShell то же самое:

```powershell
'/healthz','/','/docs/','/docs/sdd/','/docs/swagger/index.html' | ForEach-Object {
    $r = Invoke-WebRequest "https://<домен>$_" -UseBasicParsing -SkipHttpErrorCheck
    "{0,-40} {1}" -f $_, $r.StatusCode
}
```

Глазами стоит проверить три вещи:

1. На `/` рисуется экран обмена, в консоли браузера нет 404 на `/assets/…`.
2. На `/docs/` работает поиск (он подтягивает `search/search_index.json`)
   и рисуются mermaid-диаграммы в разделе «Архитектура».
3. На `/docs/swagger/` в шапке есть выпадающий список из 10 спецификаций,
   и ссылка «← Документация» ведёт на `/docs/`.

### Заголовки кеширования

```bash
curl -sI https://<домен>/ | grep -i cache-control
# → cache-control: no-cache

curl -sI https://<домен>/assets/<хешированный-файл>.js | grep -i cache-control
# → cache-control: public, max-age=31536000, immutable
```

---

## 6. Откат

**Через веб-интерфейс** (быстрее всего):
Railway → сервис → вкладка **Deployments** → нужный прошлый деплой →
меню «⋮» → **Redeploy**. Railway поднимет ранее собранный образ, пересборки
не будет — отсюда скорость.

**Через CLI:**

```bash
railway status                       # найти id нужного деплоя
railway redeploy                     # передеплоить текущий
```

**Через git** (если деплой привязан к репозиторию):

```bash
git revert <плохой-коммит>
git push
```

Автодеплой соберёт образ заново — дольше, зато история остаётся честной.

**Если ничего не помогает:** Railway → Settings → **Remove Service**, затем
создать заново. Данных, которые можно потерять, в проекте нет.

---

## 7. Локальная проверка образа перед деплоем

```bash
docker build -t bidzaar .
docker run --rm -e PORT=8090 -p 8090:8090 bidzaar
# открыть http://localhost:8090/  и  http://localhost:8090/docs/
```

Порт `8090` можно заменить на любой свободный — контейнер читает `$PORT`
на старте, пересобирать образ не нужно.

Собрать статику без Docker (нужны Node 22 и Python ≥ 3.10):

```bash
cd prototype && npm ci && npm run build          # → prototype/dist
cd ../portal   && npm ci                          # → portal/node_modules
python -m pip install -r requirements.txt
npm run build                                     # → portal/dist
```

---

## 8. Если деплой упал — куда смотреть

Порядок проверки от самого частого к самому редкому.

1. **Health-check красный, в логах `Application failed to respond`.**
   nginx не слушает тот порт, который ждёт Railway. Смотрите в логах строку
   `40-render-port.sh: конфигурация собрана, nginx слушает порт …` — если её
   нет, значит не отработал entrypoint (например, `startCommand` в
   `railway.json` переписали на голое `nginx`). Стартовая команда обязана
   идти через `/docker-entrypoint.sh`.

2. **Сборка падает на `mkdocs build --strict`.**
   `--strict` роняет сборку на любом предупреждении. Типичные причины:
   переименовали или удалили файл в `docs/**`, на который ссылается
   `--8<--` в `portal/wiki/docs/*.md`, либо сломали ссылку внутри вики.
   Точная строка с путём есть в выводе сборки.

3. **Сборка падает на `sync: не выполнен`.**
   `portal/tools/sync.py` не нашёл исходный документ. Проверьте список
   `SNIPPET_SOURCES` в этом файле: он ожидает `docs/SDD.md`,
   `docs/UX-UI-Spec.md`, `docs/api/INTEGRATIONS.md`, `promtlog.md` и другие
   в корне репозитория.

4. **Сборка падает на `COPY portal/package-lock.json`.**
   Lock-файл не закоммичен. `npm ci` без него не работает принципиально.

5. **`/docs/` отдаёт 404, `/` работает.**
   Стадия `portal-build` собрала пустой `dist`. В Dockerfile есть проверки
   `test -f dist/index.html` — если они прошли, а 404 остался, значит
   расходятся путь копирования (`/srv/www/docs/`) и `root` в конфиге nginx.

6. **Swagger UI грузится, но спецификации пустые.**
   Не отработал вендоринг: `portal/tools/sync.py` не нашёл
   `node_modules/swagger-ui-dist`. Проверьте, что `.dockerignore` не начал
   вырезать `portal/package.json` или `portal/package-lock.json`.

   Вендоринг живёт в отдельной стадии `portal-vendor` (образ Node), а стадия
   сборки документации `portal-build` — на образе Python и Node не содержит.
   Из `node_modules` между стадиями переносятся ровно два поддерева:
   `swagger-ui-dist` и `mermaid/dist/mermaid.min.js`. Если `sync.py` начнёт
   читать что-то ещё, соответствующий `COPY --from=portal-vendor` нужно
   дополнить руками — иначе `mermaid` молча подменится заглушкой, а диаграммы
   уйдут на CDN. В Dockerfile на это стоит явная проверка `test -f`.

8. **Сборка «висит» без внятной ошибки.**
   Сначала посмотрите, на каком шаге она стоит:

   ```powershell
   railway logs --build
   ```

   Наиболее затратные шаги — `npm ci` в двух стадиях и `pip install`.
   Стадии независимы, поэтому Railway может выполнять их параллельно;
   суммарное время холодной сборки ориентировочно 3–5 минут.
   Если лог обрывается без сообщения — почти всегда это лимит билдера
   (время или память), а не ошибка в Dockerfile: проверьте план проекта
   и попробуйте пересобрать без кеша.

7. **Стили вики поехали после обновления.**
   Хешированные ассеты Material отдаются с `immutable` на год. Если
   переименовали файл так, что он перестал попадать под шаблон
   `*.<8 hex>.min.(css|js)`, — правьте регулярку в
   `deploy/nginx/default.conf.template`.

---

## 9. Что сломается при перестройке проекта

Связи, которые деплой держит неявно, — за ними придётся следить руками:

* **Портал собирается из корня репозитория, а не из `portal/`.**
  `portal/wiki/mkdocs.yml` подключает `docs/**.md` и `promtlog.md` через
  `pymdownx.snippets` с `base_path: ../..`. Перенос `docs/` или `promtlog.md`
  ломает сборку образа. Строка `COPY . ./` в стадии `portal-build` — не
  небрежность, а необходимость.
* **`.dockerignore` перечисляет генерируемые каталоги поимённо.**
  Появится новый артефакт `portal/tools/sync.py` — его нужно добавить,
  иначе в образ поедет мусор с локальной машины.
* **Vite обязан класть хешированные ассеты именно в `/assets/`.**
  Смена `build.assetsDir` или `base` в `prototype/vite.config.ts` разъедет
  с `location ^~ /assets/` в конфиге nginx.
* **Прототип живёт в корне URL.** Если его понадобится перенести в
  подкаталог, нужно будет задать `base` в `vite.config.ts` — сейчас он
  собирается с абсолютными путями `/assets/…`.
* **Правило `location /docs/` не даёт SPA-fallback.** Это сознательно:
  битая ссылка в документации должна выглядеть как 404, а не как молча
  подставленный прототип.
