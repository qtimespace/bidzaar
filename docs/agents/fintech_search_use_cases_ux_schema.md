# Fintech Search: Use Cases, Entities & UX Schema

---

# 1. Overview

Цель: трансформировать поиск из простого фильтра в **unified discovery + action layer**.

Поиск должен поддерживать:
- Entity-based retrieval
- Intent detection
- Cross-domain aggregation
- Action-driven UX

---

# 2. Core Entities (индексируемые сущности)

| Entity | Type | Ключевые поля |
|--------|------|--------------|
| Account | `account` | id, currency, balance, type |
| Transaction | `transaction` | id, amount, status, date, counterparty |
| Order | `order` | pair, price, status, created_at |
| Market Asset | `market_asset` | symbol, price, change |
| FAQ | `faq` | title, content, tags |
| Notification | `notification` | type, read_status, date |
| Support Ticket | `support_ticket` | id, status, topic |
| Product | `product` | type (staking, тариф), availability |
| Audit Log | `audit_event` | user_id, action, timestamp |

---

# 3. Query Types (классификация запросов)

## 3.1 Exact / Numeric

**Примеры:**
- `35000`
- `>10000`
- `100-500`

**Поведение:**
- поиск по amount
- range filtering
- aggregation (count)

---

## 3.2 Identifier-based

**Примеры:**
- `tx_123`
- `external_id:binance`

**Поведение:**
- direct hit
- переход к объекту

---

## 3.3 Entity search

**Примеры:**
- `BTC`
- `USDT`

**Поведение:**
- cross-domain results

---

## 3.4 Intent-based

**Примеры:**
- `вывести деньги`
- `купить биткоин`

**Поведение:**
- показать CTA
- deep-link в flow

---

## 3.5 Support / Problem queries

**Примеры:**
- `не пришли деньги`
- `ошибка`

**Поведение:**
- FAQ
- support tickets

---

## 3.6 Mixed queries

**Примеры:**
- `BTC 1000 yesterday`
- `USDT failed`

**Поведение:**
- multi-filter parsing

---

# 4. Use Cases (сценарии)

## 4.1 Numeric Search
- Пользователь вводит `35000`
- Выдача:
  - транзакции с этой суммой
  - агрегаты

---

## 4.2 IBAN / Address Search
- Ввод IBAN или crypto address
- Выдача:
  - все транзакции
  - контрагент

---

## 4.3 Asset Search
- `USDT`
- Выдача:
  - счета
  - транзакции
  - ордера
  - FAQ

---

## 4.4 Product Discovery
- `Стейкинг`
- Выдача:
  - доступные программы
  - CTA

---

## 4.5 Navigation
- `настройки`
- Выдача:
  - переход в раздел

---

## 4.6 Analytics
- `failed transactions`
- Выдача:
  - список
  - count

---

## 4.7 Audit
- `user 123 14:00-16:00`
- Выдача:
  - timeline

---

# 5. UX Schema (выдача)

## 5.1 Общая структура

```
Search Results
│
├── Top Hit (если есть exact match)
│
├── Actions (если intent)
│   ├── Send Money
│   ├── Buy Crypto
│
├── Accounts
│   ├── Account 1
│   ├── Account 2
│
├── Transactions
│   ├── Tx 1
│   ├── Tx 2
│
├── Orders
│
├── Market Data
│
├── Products
│
├── FAQ / Help
│
└── Notifications
```

---

## 5.2 Пример: запрос "USDT"

```
[Search: USDT]

Top:
- USDT Account (Balance: 12,000)

Actions:
- Buy USDT
- Send USDT

Transactions:
- +500 USDT (yesterday)
- -200 USDT (Binance)

Orders:
- USDT/EUR order

Products:
- Stake USDT (5% APR)

FAQ:
- What is USDT?
```

---

## 5.3 Пример: запрос "вывести деньги"

```
Top Action:
- Withdraw Funds (CTA)

Suggested:
- Recent withdrawals
- FAQ
```

---

# 6. Ranking Logic (упрощённо)

1. Exact match > prefix
2. User-owned data > global data
3. Recent > old
4. High-frequency entities boost
5. Context-aware ranking (asset owned → boost)

---

# 7. Autocomplete UX

```
Input: "eth"

Suggestions:
- ETH account
- Buy ETH
- Stake ETH
- ETH transactions
```

---

# 8. Архитектурная модель (упрощённо)

```
User Query
   ↓
Query Parser
   ↓
Intent Detection
   ↓
Federated Search
   ├── Accounts Index
   ├── Transactions Index
   ├── FAQ Index
   ├── Market Index
   ↓
Aggregation Layer
   ↓
Ranking
   ↓
UI
```

---

# 9. Key Product Wins

- Unified search = core navigation
- Увеличение self-service
- Снижение нагрузки на support
- Рост conversion (через CTA)

---

# 10. Next Steps

- Добавить autocomplete (quick win)
- Внедрить cross-domain aggregation
- Добавить intent parsing
- Добавить lightweight analytics

---

**Итог:** поиск становится центральным интерфейсом продукта, а не вспомогательной функцией.

