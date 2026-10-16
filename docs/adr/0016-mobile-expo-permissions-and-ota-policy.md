# ADR-0016: Mobile app — Expo, minimal device permissions and a restrictive OTA policy

- **Status:** Accepted (baseline, pending owner approval) — permission stripping and disabled OTA are in code; integrity checks, OTP retrieval and the CI manifest check are planned
- **Date:** 2026-10-10
- **Related:** ADR-0009, ADR-0014, ADR-0020, ADR-0021

## Context

Research findings (`docs/research/2026-10-10/app-store-mobile.md`, `rbi-digital-lending.md` §3.10, §3.12):

- RBI digital lending: a DLA must not access files and media, contacts, call logs or telephony functions; one-time access to camera, microphone or location only for onboarding/KYC with explicit consent (confirmed (secondary)).
- Google Play personal-loan apps may not use photos/media/external storage, contacts, precise location or phone numbers; current extracts also list QUERY_ALL_PACKAGES and WRITE_EXTERNAL_STORAGE (confirmed for six, likely for two). New personal-loan apps in India must appear on RBI's public DLA list since 30 Oct 2025, which lenders populate through CIMS (confirmed, Google Help Center extracts).
- Android guidance: do not declare READ_SMS; use the SMS Retriever API, or the SMS User Consent API where the app does not control the SMS text (confirmed). The Android photo picker needs no runtime permission (confirmed). The ML Kit document scanner plugin declares no camera permission on Android; iOS VisionKit needs `NSCameraUsageDescription` (confirmed, package source).
- Expo SDK 57 = React Native 0.86.3 with the New Architecture mandatory. The Expo prebuild template and several Expo or vendor modules add storage, fine location, media and audio permissions; `android.blockedPermissions` removes them from the merged manifest and is not available in Expo Go (confirmed, package source).
- `@expo/app-integrity` wraps Play Integrity standard requests and iOS App Attest (confirmed, package source). `expo-secure-store` uses the iOS Keychain and Android Keystore (confirmed).
- OTA: Apple's licence agreement (3.3.1(B)) allows downloaded interpreted code only if it does not change the app's primary purpose or bypass security (confirmed, fetched); Play's equivalent is likely. `expo-updates` supports code signing and a fingerprint runtime policy (confirmed, package source).
- Target API 36 for new apps and updates from 31 Aug 2026; iOS builds with Xcode 26 since 28 Apr 2026 (confirmed).

## Decision

1. **Stack:** Expo SDK 57 (New Architecture), expo-router, EAS Build with development, preview and production profiles (`apps/mobile/eas.json`). Development builds, not Expo Go.
2. **No runtime permissions by default** (`android.permissions: []`, empty `infoPlist`). A permission is added only in the module that needs it, requested just in time, with a reviewed justification.
3. **Blocked permissions:** `android.blockedPermissions` strips 28 permissions from the merged manifest even if a library adds them: contacts and accounts; call log, phone state/numbers and calling; SMS/MMS; external storage and media images/video/audio; fine and background location; QUERY_ALL_PACKAGES; SYSTEM_ALERT_WINDOW; RECORD_AUDIO; calendar; body sensors; activity recognition (`apps/mobile/app.config.ts`). `allowBackup: false`.
4. **Approved replacements:** OTP via SMS Retriever / User Consent API on Android and one-time-code autofill on iOS (no SMS permission); document capture via the ML Kit Document Scanner (no camera permission on Android) or VisionKit, or a one-time camera session; uploads via the system photo or document picker (no storage permission); coarse location once, only if a lender's KYC requires it. Never contacts, SMS, call logs or media libraries.
5. **Device integrity:** Play Integrity and App Attest through `@expo/app-integrity`, verified on the server, used as tiered risk signals (step-up or assisted channel), not a sole control.
6. **Tokens** in `expo-secure-store` (Keychain `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, Android Keystore).
7. **OTA updates are disabled** (`updates.enabled: false`). If enabled later: code signing required, fingerprint runtime policy, and **never** used to change loan terms, APR or KFS logic, consent text, permissions, or to add a product or data collection. The running update id is recorded with consent and audit events.
8. **CI gate (planned):** scan the merged AndroidManifest of every release bundle and fail on any banned permission; assert target SDK 36.
9. **Store identity:** bundle id `com.udofin.app` in production and `com.udofin.app.<env>` otherwise — a **placeholder**; final identifiers are permanent once published and remain an owner decision. Store listings name the partner lenders. Production rollout on Play is gated on at least one partner lender having reported the app on CIMS.

## Alternatives considered

| Option                                             | Why rejected                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read SMS for OTP auto-fill                         | Barred by Play policy for this use and by the RBI telephony rule (research).                                                                     |
| Camera and storage permissions for document upload | Pickers and the document scanner avoid them (research).                                                                                          |
| Expo Go / managed defaults                         | `blockedPermissions` does not apply in Expo Go; defaults add banned permissions.                                                                 |
| Bare React Native or fully native apps             | More native code to maintain for a small team; Expo covers the needs found in research.                                                          |
| Web-only (PWA) borrower experience                 | No store presence; web also counts as a DLA and is not a way around store product rules (research). Borrower web is planned later for servicing. |
| OTA enabled from day one                           | Regulated screens could change without store review; risk of breaching store terms.                                                              |

## Consequences

**Positive**

- The app cannot silently gain a banned permission from a dependency.
- Onboarding needs no permission prompts for OTP or document upload.

**Negative**

- Some vendor SDKs (KYC, analytics, liveness) may be unusable if they require blocked permissions; stripping a permission a library expects can cause runtime failures, so each SDK needs testing.
- The ML Kit scanner relies on Google Play services; devices without it need a picker fallback (likely).
- Without OTA, every fix ships through store review.

**Risks and known gaps (baseline)**

- CI validates the production Expo config (`config:check` with `APP_ENV=production` in `.github/workflows/ci.yml`) but does not yet scan the merged AndroidManifest of a built bundle; no `@expo/app-integrity`, SMS retriever or `expo-updates` dependency yet.
- CAMERA and ACCESS_COARSE_LOCATION are intentionally not blocked; their use must stay one-time and KYC-only.
- RECORD_AUDIO is blocked. Video KYC runs in the lender's own flow (research KYC-08); any in-app microphone use (for example a voice assistant) needs legal review first (ADR-0019).

## Compliance and security notes

- Supports the reported RBI device-permission rule and Play/Apple loan-app policies (labels above). Evidence (planned): merged-manifest report per release; permission-request telemetry.
- Primary-source verification gate applies; Play policy text was read from search extracts and must be re-read in Play Console before submission.

## Verification

- `apps/mobile/app.config.ts` review; `pnpm --filter @udofin/mobile config:check` resolves the public config.
- Planned (research MS-03, MS-07, MS-09, MS-18): AAB permission dump fails on a banned permission; fresh install autofills OTP with no SMS permission; `targetSdkVersion == 36`; an unsigned OTA update is refused.

## Revisit triggers

- Play or Apple policy changes; RBI text verification.
- A decision to enable OTA, add voice features, or add a field-agent app.
- Final store identifiers and developer-account legal entity decided.
