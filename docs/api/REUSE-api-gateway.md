# Переиспользование `api-gateway` (CREL) — REST-проекция

> **Назначение.** Показать, что из потока обмена **уже реализовано** в
> `d:\Project\CREL\api-gateway`, и описать это в терминах REST, чтобы команда начинала
> не с чистого листа, а с существующего кода.
>
> **Что это не.** Не предложение переписать gateway и не замена
> `exchange-orders.openapi.yaml`. Спецификация описывает контракт, который мы отдаём
> клиенту; этот документ — откуда брать реализацию за ним.
>
> **Статус.** Справочный. Источник фактов — исходники gateway на момент чтения:
> `protocol/*.proto`, `cmd/main.go`, `internal/handler/http/`, `internal/middleware/auth.go`, `README.md`.

---

## 1. Что есть в gateway сегодня

| Факт | Значение |
|------|----------|
| Язык и стек | Go, gRPC + Echo (HTTP), Kafka-консюмеры, Prometheus, Jaeger |
| gRPC-сервисов зарегистрировано | **14** (namespace `gw.`), proto — в `protocol/` |
| REST-эндпоинтов | **6**: `GET /courses`, `POST /course`, `GET /email/verify`, `GET /verify-email`, `GET /health`, `GET /metrics` |
| Авторизация | Bearer-токен в gRPC-metadata `authorization`, интерсептор `internal/middleware/auth.go` |
| Публичные сервисы | `AuthService`, `CoursesService`, `InfoService` целиком + `CryptoAcquiringService.GetCAAssets` |
| Потоковые данные | gRPC server-streaming, источник — Kafka (`{prefix}_accounts`, `{prefix}_user.updated.v1`, `{prefix}_crypto_gw_deposit`) |
| Не зарегистрированы | `market.proto` (`MarketDataService`), `trades.proto` (`TradeService`) — определения есть, в `cmd/main.go` не подключены |

**Главный вывод по стеку.** REST в gateway сейчас — не полноценный слой, а несколько
служебных ручек. Основная поверхность — gRPC. Значит наша задача не «дописать REST рядом»,
а **спроецировать существующие gRPC-методы в REST** по единым правилам (§5) — тогда
и код, и семантика переиспользуются, а не дублируются.

---

## 2. Карта: девять внешних систем нашего SDD ↔ сервисы gateway

Обозначения из `docs/00-canonical-model.md` §3.

| Наша система | Сервис gateway | Покрытие | Комментарий |
|--------------|----------------|----------|-------------|
| **S1** Users | `UserService` | полное | `GetUserInfo`, `GetShortUserInfo`, `WatchUser` (stream) |
| **S2** KYC | `KYCService` | частичное | `GetUserData` даёт `ReviewStatus` и `kyc_is_done`, но **не даёт уровня верификации** — см. §7, разрыв R-3 |
| **S3** Scoring / AML | — | **нет** | Отдельного сервиса скоринга в gateway нет. Ближайшее — `ReviewResult.reject_type/labels` от KYC-провайдера |
| **S4** Limits & Fees | `ExchangerService.ExGetPairs` + `WalletService.GetConfig` + `WalletService.PrecalculateFee` | частичное | Комиссия и минимумы есть; **лимитов оборота (день/месяц/год) нет** — см. §7, разрыв R-4 |
| **S5** Exchange Rates | `CoursesService` | полное | `GetRates`, `GetAvailableSymbols`, `GetCurrencies`, `StreamRates` (stream) |
| **S6** Accounting | `AccountService` | частичное | Балансы есть, **но нет разделения `total` / `held` / `available`** — см. §7, разрыв R-1. Это самый дорогой разрыв |
| **S7** Crypto Provider | `WalletService`, `OrderBookService`, `OrderService` | полное | Сети, адреса, комиссии, стакан, депозиты |
| **S8** Order Service | `ExchangerService` (crypto) и `OrderService` (биржа) | полное | Для нашего сценария — `ExchangerService` |
| **S9** Notifications | `NotificationService` | полное | Список, счётчик, отметки о прочтении, `StreamNotifications` |

---

## 3. Главная находка: `ExchangerService` — это наш поток целиком

`protocol/exchanger.proto` реализует ровно ту двухфазную модель `quote → order`,
которую мы независимо спроектировали в `docs/api/API-Design.md` §1.

| Наш шаг | Метод gateway | Совпадение |
|---------|---------------|-----------|
| Индикативный курс, без фиксации | `ExGetExchangeRate` | По смыслу — да. По типам — нет, см. §7 дефект D-G1 |
| Котировка с фиксацией курса и TTL | **`ExFixRateForAmount`** | Полное. Возвращает `fixed_rate`, `rate_id`, `expires_at`, `result_amount`, `min`, `max` |
| Создание заявки по котировке | **`ExCreateOrder`** | Полное по форме: принимает `rate_id`. Без идемпотентности, см. D-G3 |
| Статус заявки | `ExGetOrderStatus` | Полное |
| Список заявок | `ExListOrders` | Полное |
| Каталог активов | `ExGetAssets` | Полное |
| Пары с комиссией и минимумами | `ExGetPairs` | Полное |

### Ключевое соответствие имён

| Наш термин | Термин gateway |
|------------|----------------|
| `quoteId` | **`rate_id`** |
| `expiresAt` | `expires_at` (epoch seconds) |
| `rate` (зафиксированный) | `fixed_rate` |
| `toAmount` | `result_amount` |
| `fromAmount` | `amount` |
| `feeAmount` | `fee_amount` (в `ExOrder`) |
| `minAmount` / `maxAmount` пары | `min` / `max` в ответе фиксации; `min_from_symbol` / `min_to_symbol` в паре |
| `FeePolicy.percent` | `ExExchangePair.fee_percent` |

**Что это означает практически.** Наш `POST /v1/exchange/quotes` — это REST-обёртка над
`ExFixRateForAmount`, а `POST /v1/exchange-orders` — над `ExCreateOrder`. Заново реализовывать
фиксацию курса, TTL и связывание заявки с котировкой не нужно.

---

## 4. REST-проекция уже реализованных методов

Ниже — то, ради чего документ и писался: как выглядит REST поверх существующих методов.
Пути соответствуют нашей спецификации, чтобы не разошлись два контракта.

### 4.1 Обмен — ядро

| Метод | Путь | Источник (gRPC) | Авторизация |
|-------|------|-----------------|-------------|
| `GET` | `/v1/exchange/assets` | `ExchangerService.ExGetAssets` | да |
| `GET` | `/v1/exchange/pairs` | `ExchangerService.ExGetPairs` | да |
| `GET` | `/v1/exchange/pairs/{from}/{to}/rate` | `ExchangerService.ExGetExchangeRate` | да |
| `POST` | `/v1/exchange/quotes` | `ExchangerService.ExFixRateForAmount` | да |
| `POST` | `/v1/exchange-orders` | `ExchangerService.ExCreateOrder` | да |
| `GET` | `/v1/exchange-orders/{orderId}` | `ExchangerService.ExGetOrderStatus` | да |
| `GET` | `/v1/exchange-orders` | `ExchangerService.ExListOrders` | да |

#### `GET /v1/exchange/assets`

Прямая проекция `ExGetAssets`. Ответ — массив `ExAssetConfig`:

| Поле gateway | REST | Тип | Примечание |
|--------------|------|-----|------------|
| `currency_code` | `assetId` | string | |
| `net_name` | `network` | string | |
| `decimals` | `decimals` | integer | Точность актива |
| `net_decimals` | `networkDecimals` | integer | Точность в сети — может отличаться от `decimals` |
| `is_active` | `enabled` | boolean | Неактивные **не скрывать**, отдавать с флагом: иначе клиент не отличит «нет актива» от «актив выключен» |
| `net_contract` | `contract` | string \| null | Адрес контракта для токенов |
| `net_native` | `isNativeCoin` | boolean | |

#### `GET /v1/exchange/pairs`

Проекция `ExGetPairs`. Query: `from`, `to` — оба необязательные (в proto это фильтр).

Отдавать наружу **не весь** `ExExchangePair`: сообщение содержит внутренние поля провайдеров
(`cgw_*`, `exg_*`, `acc_*`, `crs_symbol_*`), которые клиенту не нужны и раскрывают устройство
интеграций. Наружу идёт:

| Поле gateway | REST |
|--------------|------|
| `from_symbol` / `to_symbol` | `fromAssetId` / `toAssetId` |
| `fee_percent` | `feePolicy.percent` |
| `min_from_symbol` | `minAmount` |
| `min_to_symbol` | `minToAmount` |
| `is_active` | `enabled` |

**Важная оговорка из самого proto:** `min_from_symbol` / `min_to_symbol` рассчитываются из
константы `EXCHANGER_MIN_AMOUNT_USDT` по курсу сервиса courses и **могут быть пустыми**, если
курс недоступен. REST обязан решить, что делать в этом случае, и решение должно быть явным:
отдавать `null` и запрещать обмен по паре, либо отдавать дефолт с признаком. Молча отдать
пустую строку — значит переложить неоднозначность на клиента.

#### `POST /v1/exchange/quotes` ← `ExFixRateForAmount`

Запрос:

```json
{ "fromAsset": { "assetId": "RUB" }, "toAsset": { "assetId": "USDT" }, "fromAmount": "10000.00" }
```

Ответ (проекция `ExFixRateForAmountResponse`):

| Поле gateway | REST | Примечание |
|--------------|------|------------|
| `rate_id` | `quoteId` | |
| `fixed_rate` | `rate` | Уже строка — совпадает с нашим требованием |
| `result_amount` | `toAmount` | Уже строка |
| `expires_at` | `expiresAt` | `int64` epoch → ISO-8601 UTC при проекции |
| `min` / `max` | `limits.min` / `limits.max` | Границы для этой пары |

Отсутствуют против нашего контракта и должны быть посчитаны на уровне BFF:
`feeAmount`, `netFromAmount`, `inverseRate`, `degraded`, `rateSource`.

#### `POST /v1/exchange-orders` ← `ExCreateOrder`

```json
{ "quoteId": "<rate_id>", "fromAmount": "10000.00",
  "fromAsset": { "assetId": "RUB" }, "toAsset": { "assetId": "USDT" } }
```

`ExCreateOrderResponse` возвращает только `order_id` и `status`. Наш контракт обещает клиенту
полный снапшот заявки, поэтому BFF после создания дополняет ответ данными котировки, которую
сам же и выдавал, — второй вызов в gateway для этого не нужен.

**`user_id` в запросе отсутствует намеренно** — в proto он помечен как удалённый и берётся
из авторизационного контекста. Это тот же приём, которым мы обосновывали отсутствие `walletId`
в пути `GET /v1/wallet/balances`: идентификатор владельца, приходящий из тела запроса, —
готовый вектор доступа к чужим данным.

#### `GET /v1/exchange-orders/{orderId}` ← `ExGetOrderStatus`

Проекция один в один. Заметное поле — `deposit_wallet_address`: у крипто-обмена есть адрес
депозита, которого в нашей модели внутреннего обмена нет. Наружу отдавать только когда непусто.

Маппинг статусов:

| `ExOrderStatus` | Наш `OrderStatus` |
|-----------------|-------------------|
| `NEW`, `PENDING` | `PENDING` |
| `COMPLETED` | `COMPLETED` |
| `FAILED` | `FAILED` |
| `CANCELLED` | `CANCELLED` |
| `EXPIRED` | `EXPIRED` |
| `UNSPECIFIED` | ошибка маппинга, а не «неизвестный статус» наружу |
| — | `MANUAL_REVIEW` — **соответствия нет**, см. §7 разрыв R-2 |

#### `GET /v1/exchange-orders` ← `ExListOrders`

Query: `status`, `limit`, `offset`. Ответ: `{ "items": [...], "total": N }`.

В proto `ExListOrdersRequest.status` — **одиночное** значение, тогда как фиатный аналог
`ExGetFiatOrdersRequest.statuses` — `repeated`. Для REST разумно принимать
`?status=PENDING&status=EXECUTING` в обоих случаях и схлопывать в один вызов там, где gRPC
принимает только одно значение.

Наш `?idempotencyKey=` (решение O-10) поверх этого метода **не реализуется**: в gateway такого
поиска нет, см. §7 разрыв R-5.

### 4.2 Курсы — `CoursesService` (публичный)

| Метод | Путь | Источник |
|-------|------|----------|
| `GET` | `/v1/rates?symbols=BTC/USDT,ETH/USDT` | `GetRates` |
| `GET` | `/v1/rates/symbols` | `GetAvailableSymbols` |
| `GET` | `/v1/currencies?activeOnly=true` | `GetCurrencies` |
| `GET` | `/v1/rates/stream` (SSE) | `StreamRates` |

`Rate` уже отдаёт `price` **строкой** и содержит флаг `valid` — это готовый эквивалент нашего
признака «котировка построена на устаревших данных». Переиспользовать, а не заводить свой.

`Currency` содержит `precision`, `is_crypto`, `is_active`, `image_url` — этого достаточно для
каталога активов на экране обмена.

### 4.3 Балансы — `AccountService`

| Метод | Путь | Источник |
|-------|------|----------|
| `GET` | `/v1/wallet/balances` | `GetAccounts` либо `SumAccountsByAssetSymbol` |
| `GET` | `/v1/wallet/accounts/{id}` | `GetAccount` |
| `GET` | `/v1/wallet/assets` | `GetAssets` |
| `GET` | `/v1/wallet/transactions` | `GetTransactions` |
| `GET` | `/v1/wallet/balances/stream` (SSE) | `WatchAccounts` |

`SumAccountsByAssetSymbol` удобнее для экрана обмена: возвращает `AssetBalance{asset_symbol,
total_balance}`, то есть сумму по всем счетам в разрезе символа — ровно то, что показывает
строка `Available:`. Но именно здесь наш самый крупный разрыв: `total_balance` — **одно** число,
а нам нужны `total` / `held` / `available` (см. §7, R-1).

### 4.4 Комиссии и сети — `WalletService`

| Метод | Путь | Источник |
|-------|------|----------|
| `GET` | `/v1/wallet/config` | `GetConfig` |
| `POST` | `/v1/wallet/fees/precalculate` | `PrecalculateFee` |
| `GET` | `/v1/wallet/addresses` | `GetAddress` |
| `POST` | `/v1/wallet/withdrawals` | `CreateWithdraw` |
| `GET` | `/v1/wallet/withdrawals` | `GetWithdrawList` |
| `GET` | `/v1/wallet/deposits/stream` (SSE) | `WatchDeposits` |

**`PrecalculateFee` заслуживает отдельного внимания — это готовый образец для нас.**

```
enum FeeMode { FEE_ON_TOP = 0; FEE_INCLUDED = 1; }

PrecalculateFeeResponse {
  fee_amount, fee_currency, applied_rule_id, is_default_applied,
  send_amount,   // ON_TOP: amount; INCLUDED: amount − fee
  total_amount   // ON_TOP: amount + fee; INCLUDED: amount
}
```

Три вещи, которые надо взять как есть:

1. **`FEE_INCLUDED` — это ровно наш `INCLUDED_IN_SOURCE`** (`docs/00-canonical-model.md` §5.3).
   Термин уже существует в кодовой базе компании; наше имя стоит привести к нему, а не наоборот.
2. **`send_amount` / `total_amount` — это наши `netFromAmount` / `fromAmount`.** Пара полей,
   снимающая ровно ту путаницу, ради которой мы завели строку `Total debited` в сводке.
3. **`applied_rule_id` + `is_default_applied`** — готовый механизм признать «применён дефолт,
   а не настроенное правило». Это ровно то, чего требует наше решение O-8 для порога дрейфа
   при недоступности S4: дефолт должен быть виден, а не маскироваться под норму.

### 4.5 KYC — `KYCService`

| Метод | Путь | Источник |
|-------|------|----------|
| `GET` | `/v1/kyc/status` | `GetUserData` |
| `POST` | `/v1/kyc/access-token` | `GetAccessToken` |

`GetUserData` возвращает `ReviewStatus` (`PENDING/INIT/PRECHECKED/QUEUED/COMPLETED/ON_HOLD`),
`kyc_is_done` и `ReviewResult{answer, reject_type, labels}`. Провайдер — SumSub
(`level_name`, `applicantId`), а не WebID, как предполагала наша интеграционная спецификация:
`ASSUMPTION-01` в `docs/api/INTEGRATIONS.md` подтверждения не получил и должен быть пересмотрен.

Маппинг в наш `KycStatus`:

| gateway | наш |
|---------|-----|
| `REVIEW_STATUS_INIT`, `REVIEW_STATUS_PENDING` | `IN_PROGRESS` |
| `REVIEW_STATUS_QUEUED`, `REVIEW_STATUS_PRECHECKED` | `PENDING_REVIEW` |
| `REVIEW_STATUS_COMPLETED` + `kyc_is_done = true` | `APPROVED` |
| `REVIEW_STATUS_COMPLETED` + `answer` = отказ | `REJECTED` |
| `REVIEW_STATUS_ON_HOLD` | `PENDING_REVIEW` |

### 4.6 Уведомления — `NotificationService`

| Метод | Путь | Источник |
|-------|------|----------|
| `GET` | `/v1/notifications?includeRead=&page=&size=` | `GetNotifications` |
| `GET` | `/v1/notifications/total` | `GetNotificationsTotal` |
| `POST` | `/v1/notifications/read` | `MarkNotificationAsRead` (тело: `{ "ids": [...] }`) |
| `POST` | `/v1/notifications/read-all` | `MarkNotificationAsReadAll` |
| `GET` | `/v1/notifications/stream` (SSE) | `StreamNotifications` |

Отметка о прочтении — `POST` на под-ресурс, а не `PATCH` на коллекцию: операция не идемпотентна
по телу и не является частичным обновлением ресурса.

---

## 5. Правила проекции gRPC → REST

Нормативная часть. Без общих правил каждая ручка будет спроецирована по-своему.

| Аспект | Правило | Почему |
|--------|---------|--------|
| **Именование полей** | `snake_case` в proto → `camelCase` в JSON | Наш §9 канона; конвертация механическая |
| **Идентификатор владельца** | Никогда не принимаем из тела или пути — только из токена | В proto это уже сделано (`user_id удалён`); повторить в REST |
| **Время** | `int64` epoch и `google.protobuf.Timestamp` → **ISO-8601 UTC с миллисекундами** | В gateway сейчас два формата вперемешку; наружу должен идти один |
| **Деньги и курсы** | Всегда строка. Если в proto `double` — **BFF обязан привести к строке из источника, а не через float** | См. §7 D-G1: приведение `double → string` уже после потери точности бесполезно |
| **Enum** | `EX_ORDER_STATUS_PENDING` → `PENDING` (снимаем префикс сервиса) | `UNSPECIFIED` наружу не выпускаем: это ошибка маппинга |
| **Пагинация** | Единая: `limit` + `offset`, ответ `{ items, total }` | Сейчас три схемы: `limit/offset` (exchanger), `after_id/limit` (wallet), `page/size` (notifications) |
| **Ошибки** | gRPC-код → HTTP по таблице ниже, тело — `application/problem+json` по каталогу §7 канона | Клиент ветвится по `code`, а не по тексту |
| **Стримы** | server-streaming → **SSE** для однонаправленных обновлений | Курсы, балансы, уведомления, депозиты — всё однонаправленное; WebSocket не нужен |
| **Пустые значения** | Не отдавать пустую строку там, где семантика — «значения нет»: `null` + признак | `min_from_symbol` может быть пуст при недоступном курсе |

### Маппинг gRPC-кодов в HTTP

| gRPC | HTTP | Наш код ошибки |
|------|------|----------------|
| `INVALID_ARGUMENT` | 400 | `VALIDATION_ERROR` |
| `UNAUTHENTICATED` | 401 | — |
| `PERMISSION_DENIED` | 403 | `KYC_*`, `SCORING_DENIED`, `USER_BLOCKED` |
| `NOT_FOUND` | 404 | `QUOTE_NOT_FOUND`, `ORDER_NOT_FOUND` |
| `ALREADY_EXISTS` | 409 | `QUOTE_ALREADY_USED`, `IDEMPOTENCY_CONFLICT` |
| `ABORTED` | 409 | `RATE_CHANGED`, `HOLD_FAILED` |
| `FAILED_PRECONDITION` | 422 | `AMOUNT_*`, `INSUFFICIENT_FUNDS`, `LIMIT_EXCEEDED_*` |
| `RESOURCE_EXHAUSTED` | 429 | `RATE_LIMITED` |
| `UNAVAILABLE` | 503 | `RATE_SERVICE_UNAVAILABLE`, `EXCHANGE_SERVICE_UNAVAILABLE` |
| `DEADLINE_EXCEEDED` | 504 | `UPSTREAM_TIMEOUT` |

---

## 6. Что переиспользуется, что дорабатывается, чего нет

| Категория | Состав |
|-----------|--------|
| **Берём как есть** | `ExGetAssets`, `ExGetPairs`, `ExFixRateForAmount`, `ExGetOrderStatus`, `ExListOrders`, весь `CoursesService`, `NotificationService`, `WalletService.GetConfig` и `PrecalculateFee`, `AccountService.GetAssets` |
| **Дорабатываем** | `ExCreateOrder` (идемпотентность), `ExGetExchangeRate` (типы), `AccountService` (`held`/`available`), `KYCService` (уровень верификации) |
| **Пишем с нуля** | Скоринг (S3), лимиты оборота (S4), цепочка проверок §6 канона, каталог ошибок, `MANUAL_REVIEW` как состояние |

Цепочка проверок остаётся **нашей** в любом случае: gateway — транспорт и агрегация,
он не место для бизнес-правил обмена. Это же и ответ на вопрос «не проще ли ходить
из фронта прямо в gateway»: проще, но тогда порядок проверок и детерминированность
ошибки становятся заботой каждого клиента отдельно.

---

## 7. Дефекты и разрывы, найденные в существующих контрактах

Перечислено честно и с оценкой, потому что это то, обо что команда споткнётся первой.

### Дефекты

| # | Что | Где | Оценка |
|---|-----|-----|--------|
| **D-G1** | `ExGetExchangeRateResponse.rate` — **`double`**, тогда как в том же сервисе `ExFixRateForAmount` отдаёт `fixed_rate` строкой | `exchanger.proto` | **Высокая.** Курс в бинарном float теряет точность до того, как BFF успеет что-либо сделать. Внутри одного сервиса два разных решения одной задачи |
| **D-G2** | Все фиатные суммы — `double`: `amount_from`, `amount_to`, `send_min/max`, `get_min/max`, `rate`, `min_amount`, `max_amount` | `exchanger.proto`, фиатная часть | **Высокая.** Это уже не курс, а деньги |
| **D-G3** | `ExCreateOrder` не принимает ключ идемпотентности | `exchanger.proto` | **Высокая.** Ретрай после таймаута создаёт вторую заявку. Ровно тот сценарий, ради которого в нашем контракте `Idempotency-Key` обязателен |
| **D-G4** | Три схемы пагинации в одном gateway | exchanger / wallet / notifications | Средняя. Наружу должна идти одна |
| **D-G5** | Два формата времени: `int64` epoch и `google.protobuf.Timestamp` | exchanger, notifications ↔ courses, accounts, wallet | Средняя |
| **D-G6** | `ExListOrders` принимает один статус, фиатный аналог — список | `exchanger.proto` | Низкая, но чинится дёшево |
| **D-G7** | `Account.amount_usd` помечен «пока не используется, ждём сервис курсов» | `accounts.proto` | Низкая. Поле в контракте, значения нет — клиент не может отличить «ноль» от «не посчитано» |

### Разрывы покрытия

| # | Чего нет | Последствие | Что делать |
|---|----------|-------------|-----------|
| **R-1** | Разделения `total` / `held` / `available` в балансах | Наша проверка достаточности средств ведётся по `available`, а gateway отдаёт одно число. Без резервов заявка может быть создана на средства, уже занятые другой операцией | Самый дорогой разрыв. Либо `AccountService` учит `held`, либо резервы живут у нас и мы вычитаем сами — второе означает, что два источника истины про деньги |
| **R-2** | Состояния `MANUAL_REVIEW` | Скоринг с решением `REVIEW` некуда положить: `ExOrderStatus` такого статуса не знает | Добавить в enum либо держать состояние у себя, не отражая в gateway |
| **R-3** | Уровня верификации в KYC | `kyc_is_done` — булево, а наша цепочка требует уровень (§6 шаг 14) | Уточнить у владельцев kyc-svc: уровень есть в SumSub (`level_name`), но наружу не отдаётся |
| **R-4** | Лимитов оборота день/месяц/год | Решения O-11 и O-12 реализовать не на чем | Отдельный сервис лимитов либо расширение существующего |
| **R-5** | Поиска заявки по ключу идемпотентности | Решение O-10 нереализуемо поверх gateway | Следует из D-G3: сначала ключ, потом поиск по нему |
| **R-6** | Скоринга / AML | Шаг 16 цепочки не на чём выполнять | — |

---

## 8. Приёмы из gateway, которые стоит забрать в наш контракт

Обратное направление: не только мы берём код, но и контракт стоит поправить по образцу.

1. **`FeeMode` вместо нашего `INCLUDED_IN_SOURCE`.** Термин уже живёт в кодовой базе
   (`FEE_ON_TOP` / `FEE_INCLUDED`), и наше отдельное имя создаёт лишний словарь.
2. **`send_amount` / `total_amount`.** Пара полей из `PrecalculateFee` называет то же, что
   наши `netFromAmount` / `fromAmount`, но понятнее для читателя со стороны.
3. **`applied_rule_id` + `is_default_applied`.** Готовый способ показать, что применён дефолт.
   Наше решение O-8 (порог дрейфа от S4 с дефолтом при недоступности) требует ровно такого
   признака — иначе неработающая интеграция выглядит как штатная работа.
4. **`Rate.valid`.** Признак пригодности котировки на стороне источника — то же, что наш
   `degraded`, но ближе к источнику.
5. **Двухшаговое подтверждение SCA.** В `ExCreateFiatOrder` и `CreateWithdraw` есть пара
   `totp_code` + `challenge_id`: пустой запрос → ответ `sca_required` + `challenge_id`,
   повтор с кодом → подтверждение. Готовый образец step-up-подтверждения, если для крупных
   обменов потребуется дополнительный фактор.
6. **Удаление `user_id` из запросов.** В proto это уже сделано осознанно и помечено
   комментариями — тот же аргумент, которым мы обосновывали отсутствие `walletId` в пути.

---

## 9. Что делать команде — порядок работ

1. **Согласовать `rate_id` ↔ `quoteId`** и договориться, чьё имя остаётся. Пока это два имени
   одной сущности, любой разговор о котировках будет требовать перевода.
2. **Починить `ExGetExchangeRate` (D-G1)** — сделать `rate` строкой. Это ломающее изменение
   proto, поэтому чем раньше, тем дешевле.
3. **Добавить ключ идемпотентности в `ExCreateOrder` (D-G3)** и поиск по нему (R-5).
4. **Решить вопрос `held` / `available` (R-1)** — до начала реализации, а не после: от ответа
   зависит, где живут резервы и сколько источников истины про деньги в системе.
5. **Спроецировать методы из §4** по правилам §5, начиная с ядра обмена (§4.1).
6. **Уточнить у владельцев kyc-svc уровень верификации (R-3)** и заодно пересмотреть
   `ASSUMPTION-01` в `docs/api/INTEGRATIONS.md`: провайдер — SumSub, а не WebID.

---

## Ссылки

| Документ | Роль |
|----------|------|
| `docs/00-canonical-model.md` | Нормативный доменный контракт |
| `docs/api/exchange-orders.openapi.yaml` | Контракт, который отдаём клиенту |
| `docs/api/API-Design.md` | Почему контракт такой |
| `docs/api/INTEGRATIONS.md` | Что приложение получает от внешних систем |
| `docs/SDD.md` | Архитектура, точки отказа |
| `d:\Project\CREL\api-gateway\README.md` | Первоисточник по gateway |
