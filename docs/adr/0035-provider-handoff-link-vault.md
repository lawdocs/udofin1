# ADR 0035: Provider hand-off links rest only as ciphertext in a vault

Date: 2026-10-16. Status: proposed for owner approval (Phase 08a). Related: ADR 0008, 0009, 0011, 0034.

## Context

To pay, or to authorise a repayment mandate, the borrower opens a link that the lender's payment provider or bank creates. The link
is a bearer secret: whoever holds it can complete the payment or the mandate. The spec requires that it is not stored in clear, not
logged, and not put in an event. The provider is called by the **worker**, which alone holds the lender's provider credentials (the
public API never does, and a test enforces that the system login stays out of the API process). The borrower fetches the link
through the **API**. A route runs in one transaction, so the request that creates the payment cannot wait for the worker, which
cannot see an uncommitted payment. The link therefore has to travel from the worker to the API, after the fact, through something.

## Decision

`payments.handoff_links` keeps one row per payment or mandate, holding **only ciphertext**: AES-256-GCM, a fresh random nonce, the
subject kind, subject id and lender id as associated data, under a key that never enters the database (`HANDOFF_ENCRYPTION_KEYS`,
from a secrets manager, versioned; the worker seals with the active version, the API opens any listed version). No database role
has any privilege on the table. Three definer functions are its only door:

- `payments.store_handoff_link` (system role): the lender and the borrower come from the payment or mandate, not from the caller; a
  payment must be `pending` and a mandate `registration_pending`; the expiry is at most 31 days; a repeat replaces the row.
- `payments.take_handoff_link` (the owning borrower): returns the ciphertext only while the link has not expired, the subject is
  still open and the lender's switch is on; every read is counted.
- `payments.purge_handoff_links` (system role): deletes expired rows and rows whose subject is no longer open.

The API decrypts for the response (`cache-control: no-store`, tight rate limit, never logged). A blob moved to another subject fails
authentication. An audit event names the key version and nothing else.

## Alternatives considered

- **The API calls the provider.** Rejected: it puts every lender's provider credentials in the public API.
- **Store the link in clear for a few minutes.** Rejected: it breaks the "not stored in clear" rule for the duration, and a database
  read, backup or replica would expose a live bearer secret.
- **Hand it over in the outbox event or a notification.** Rejected: events are logged, replayed and kept; push payloads carry
  opaque ids only.
- **Encrypt to the borrower's device.** Rejected: no per-device key exists, and the app would need new key handling for one link.

## Consequences

- The database cannot verify that a stored blob is ciphertext; the worker's tests show that the stored bytes contain no part of
  the link, and a check bounds the blob size.
- The API process holds the decryption keys (not provider credentials). A leaked key exposes only links that have not expired and
  whose subjects are still open; keys rotate by adding a version and retiring the old one after its links have expired.
- Without keys configured the worker records the order or mandate without a link and the borrower is told honestly that no link is
  available; nothing is invented.
- The link remains fetchable until it expires or the subject leaves its open state, so a lost network response does not strand a
  borrower; the read count is the evidence of use.
