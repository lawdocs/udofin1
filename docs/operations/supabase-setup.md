# Supabase set-up runbook (staging and production)

**Status:** written 13 October 2026 for Phase 02. Nothing here has been run against a hosted project yet; the owner or an authorised engineer performs these steps. **Do not apply anything to the prototype project `Udofin-app`** (see `docs/specs/02-database-security.md`, Q1).

## 0. Principles

- A hosted project holds real borrower data only in the **Mumbai (ap-south-1)** region (CLAUDE.md rule 7). Staging uses **synthetic data only**.
- Supabase is **not** the only security boundary. Mobile apps and browsers never receive a service key; they talk to the Udofin API (ADR 0005).
- Passwords and keys are created by a person and stored in a secrets manager. They are never written in a migration, a ticket or this repository.

## 1. Create the project (once per environment)

1. Create a project in region **Mumbai**; plan **Pro** (decision Q6). Name it `udofin-staging` or `udofin-production`.
2. Generate a long random database password and store it in the secrets manager. Do not reuse it elsewhere.
3. In _Authentication → Sign In / Providers_: enable **Phone** (borrowers) with the SMS provider chosen in Phase 05; **disable Email signups** (staff are created by invitation only); disable anonymous sign-ins.
4. In _Authentication → Signing keys_: migrate to **asymmetric signing keys** (ES256 or RS256). The API verifies tokens against the project's JWKS and refuses shared-secret (HS256) tokens.

## 2. Push the configuration we keep in version control

`supabase/config.toml` holds the Auth settings (password length 12 with mixed classes, 15-minute access tokens, refresh-token rotation, TOTP enabled, session time-box 24 h and inactivity 8 h, email signup off). Review it, then:

```bash
supabase link --project-ref <ref>
supabase config push        # shows a diff first; read it before confirming
supabase db push            # applies supabase/migrations to the linked project
```

Settings the CLI cannot push, to set by hand in the dashboard: SMTP/SMS providers, **Network Restrictions** (step 4), and enforcement of MFA for staff (the API enforces `aal2`; the database functions also refuse an `aal1` session).

## 3. Database logins (after the migrations)

Migration `20261013000720` creates two logins **without passwords**:

| Login           | Can assume           | Used by                                                                  |
| --------------- | -------------------- | ------------------------------------------------------------------------ |
| `udofin_api`    | `authenticated` only | every user-initiated API request (row-level security applies)            |
| `udofin_system` | `service_role` only  | workers and the narrow change-request module (`services/api/src/system`) |

As the project owner, in the SQL editor, run (replace the placeholders with generated passwords from the secrets manager; never paste them into chat or a commit):

```sql
alter role udofin_api    password '<generated-1>';
alter role udofin_system password '<generated-2>';
-- Only if the migration printed the WARNING "could not grant platform roles":
grant authenticated to udofin_api    with inherit false, set true;
grant service_role  to udofin_system with inherit false, set true;
```

Connection strings use the **direct** connection or the session pooler (the API sets `SET LOCAL ROLE` inside transactions, so use transaction-safe settings) with `sslmode=verify-full`. The API **refuses to start** if `udofin_api` is a superuser, can bypass row-level security, can create roles, or can assume `service_role`.

## 4. Network restrictions (the "fixed IP")

On the Pro plan, _Database → Network Restrictions_ is an **allow-list of addresses that may connect to the database**. Set it to:

1. the **API host's static outbound address** (a reserved/elastic IP on whichever India-region server hosts the API), and
2. named administrator addresses (office/VPN), each with an owner and a review date recorded in the table below.

This is separate from the address lenders and providers ask for (our **outbound** address), which comes from the API host, not from Supabase. Both are needed (Q2). Record each address here when it exists:

| Purpose             | Address | Owner | Added | Review by |
| ------------------- | ------- | ----- | ----- | --------- |
| API host (egress)   | _tbd_   |       |       |           |
| Administrator (VPN) | _tbd_   |       |       |           |

Verify the current plan features on the Supabase pricing and docs pages before relying on this; they change.

## 5. First administrators (bootstrap)

Two-person change control needs two people before anyone can be added. A named engineer, with a second person watching, inserts the **platform organisation** and the first **two platform administrators** directly as the database owner (the only exempt path), then records the action in the change log. Everything after that goes through `POST /v1/admin/change-requests`. Each administrator enrols an authenticator app before first use.

## 6. After set-up: checks

- `GET /health/ready` on the API reports the database as `ok`.
- Run the Phase 02 integration tests against the **staging** project's login (never production).
- Supabase _Advisors_ (security and performance) show no unaddressed warnings for the domain schemas.
