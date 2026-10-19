# Product configuration and lender transactions panel API

Routes under `/v1/lender`, staff session with second factor. Writes are idempotent POSTs.

## Products

`GET product-config-schema` (what can be configured), `GET product-categories`, `GET products`, `POST products`, `POST products/:id/status`, `POST products/:id/versions`, `POST product-versions/:id/draft`, `/submit`, `/decision`, `/retire`. Money is integer paise (JSON numbers up to 1e14). Rule codes: `self_approval` (403), `no_approved_version` (409).

## Transactions

`GET transactions/catalogue`, `GET transactions` (filters: lenderId, kinds, statuses, productId, from, to, minAmountMinor, maxAmountMinor, q, order, limit, cursor), `GET transactions/summary` (groupBy kind|status|product|day|month), `GET transactions/export` (columns, same filters), `GET transactions/:kind/:id`.
Amounts are decimal strings of paise. Export is capped at 5,000 rows (`truncated` tells you), limited to 6 per minute and recorded in the audit trail.

## Saved views

`GET panel-views`, `POST panel-views`, `POST panel-views/:id` (rename, share, change configuration, `archive`). A view stores filters, columns, ordering, range and grouping, never data.
