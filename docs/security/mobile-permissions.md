# Mobile permission plan (borrower app)

- **Date:** 2026-10-10. **Owner:** mobile lead (engineering owner not yet appointed). **Approver:** product owner.
- **Applies to:** `apps/mobile` (Expo SDK 57, React Native 0.86.3). Android first; iOS after Android.
- **Related:** [`threat-model.md`](threat-model.md) (AC-15, G-23), [`checklist.md`](checklist.md)
  (A-14, B-4, B-5), `docs/research/2026-10-10/app-store-mobile.md` (source of most facts below).

> **Research limitation.** During research the sandbox could not open rbi.org.in or other primary
> sources, and Google Play Help pages could be read only as search-result extracts; the web-search
> budget ran out. Apple and Android developer pages and the npm packages were read directly. Status
> labels **confirmed / likely / interpretation / unverified** are carried over from the research.
> RBI references must be verified against the primary text before launch (release gate B-13 in
> [`checklist.md`](checklist.md)).

**In one sentence:** the app asks for no permission by default, uses system pickers and Google Play
services instead of permissions wherever possible, asks for a permission only at the step that
needs it and only once, always offers another way forward if the borrower says no, and strips every
prohibited permission from the Android build even if a library tries to add it.

---

## 1. Rules that drive the plan

| Source                                                                       | Rule                                                                                                                                                                                                                                                                                              | Status                                                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| RBI digital lending rules (2022 guidelines carried into the 2025 Directions) | Digital lending apps must not access files and media, contact list, call logs or telephony functions. One-time access to camera, microphone, location or another facility is allowed only for onboarding/KYC, with the borrower's explicit consent.                                               | likely (app-store and privacy notes); listed as confirmed from secondary sources in `rbi-digital-lending.md` (DL-17). Treat as binding. |
| Google Play, personal-loan apps (Financial Services policy)                  | Prohibited: `READ_EXTERNAL_STORAGE`, `READ_MEDIA_IMAGES`, `READ_CONTACTS`, `ACCESS_FINE_LOCATION`, `READ_PHONE_NUMBERS`, `READ_MEDIA_VIDEO` (since 31 May 2023). Later additions: `QUERY_ALL_PACKAGES`, `WRITE_EXTERNAL_STORAGE`. Scope includes facilitators and lead generators such as Udofin. | confirmed (first six); likely (two additions)                                                                                           |
| Google Play, India                                                           | New personal-loan apps are accepted only if they are on RBI's public list of DLAs reported by regulated entities (from 30 Oct 2025).                                                                                                                                                              | confirmed (Google Help extract)                                                                                                         |
| Google Play, SMS and Call Log policy                                         | SMS and call-log permission groups are restricted to default handlers. For OTP, use the SMS Retriever API, or the SMS User Consent API when the app does not control the message.                                                                                                                 | confirmed                                                                                                                               |
| Google Play, target API                                                      | New apps and updates must target Android 16 (API 36) from 31 Aug 2026. Expo SDK 57 defaults to target 36.                                                                                                                                                                                         | confirmed                                                                                                                               |
| Apple 5.1.1(iii), (iv)                                                       | Use out-of-process pickers; offer alternatives when a permission is denied.                                                                                                                                                                                                                       | confirmed                                                                                                                               |
| Apple 5.1.2(i)                                                               | No gating of features on location, push or tracking consent; disclose and get permission before sharing personal data with third-party AI.                                                                                                                                                        | confirmed                                                                                                                               |
| Apple 4.5.4                                                                  | Marketing push only after explicit opt-in, with an in-app opt-out; push should not carry sensitive personal information.                                                                                                                                                                          | confirmed                                                                                                                               |
| Apple 2.5.14                                                                 | Explicit consent and a visible indicator when recording (relevant to selfie video or video KYC).                                                                                                                                                                                                  | confirmed                                                                                                                               |
| Apple App Tracking Transparency                                              | Not needed if the app has no advertising or attribution SDKs.                                                                                                                                                                                                                                     | interpretation                                                                                                                          |

---

## 2. Principles

1. **Nothing by default.** `android.permissions: []` and `ios.infoPlist: {}` in `apps/mobile/app.config.ts`. Each permission is added only in the module that needs it, with an approved entry in section 4.
2. **Avoid the permission altogether** where a system component does the job: Phone Number Hint instead of phone-state permissions, SMS Retriever instead of SMS permissions, the photo and document pickers instead of storage or media permissions, the ML Kit Document Scanner instead of the camera permission on Android, DigiLocker instead of photographing documents.
3. **Just in time, once.** Ask at the step that needs it, after a screen that explains why in plain language, never at launch. Where Android offers "only this time", accept it; the app does not ask again later for the same purpose.
4. **Record the consent.** For camera, microphone or location the explanation screen records the borrower's decision in `consent.records` with the notice version, so the one-time, explicit-consent rule has evidence.
5. **Always a fallback.** Denying a permission never blocks the journey (Apple 5.1.1(iv), 5.1.2(i)); section 5 lists the fallback for every step.
6. **Coarse, not precise.** If location is ever needed, coarse only; fine and background location stay blocked.
7. **Never for collections.** No permission is ever requested for reminders, recovery or collections other than notifications the borrower turns on.
8. **No over-the-air permission changes.** OTA updates are disabled (`updates.enabled: false`); a permission change always ships as a reviewed store build.

---

## 3. Current state (2026-10-10)

`apps/mobile/app.config.ts` today:

| Setting                      | Value                              | Effect                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `android.permissions`        | `[]`                               | The app itself declares no permission. Normal install-time permissions such as `INTERNET` still come from the Expo template.                                                                                                                               |
| `android.blockedPermissions` | 28 entries (listed below)          | Written as `<uses-permission tools:node="remove">` into the final manifest at prebuild, so they are removed even if a library's manifest adds them (confirmed, `@expo/config-plugins` source). Works in development and production builds, not in Expo Go. |
| `android.allowBackup`        | `false`                            | App data is excluded from Android backup.                                                                                                                                                                                                                  |
| `ios.infoPlist`              | `{}`                               | No usage-description strings, so iOS cannot show any permission prompt.                                                                                                                                                                                    |
| `plugins`                    | `expo-router`, `expo-secure-store` | Neither adds a runtime permission. The secure-store plugin writes backup-exclusion rules (confirmed, research §5).                                                                                                                                         |
| `updates.enabled`            | `false`                            | No over-the-air updates.                                                                                                                                                                                                                                   |

The 28 permissions blocked today, exactly as listed in `BLOCKED_ANDROID_PERMISSIONS` (all are
`android.permission.*`):

| Group                           | Blocked permissions                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Contacts and accounts           | `READ_CONTACTS`, `WRITE_CONTACTS`, `GET_ACCOUNTS`                                                                                         |
| Call log and phone              | `READ_CALL_LOG`, `WRITE_CALL_LOG`, `PROCESS_OUTGOING_CALLS`, `READ_PHONE_STATE`, `READ_PHONE_NUMBERS`, `CALL_PHONE`                       |
| SMS and MMS                     | `READ_SMS`, `RECEIVE_SMS`, `SEND_SMS`, `RECEIVE_MMS`                                                                                      |
| Storage and media               | `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `MANAGE_EXTERNAL_STORAGE`, `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_MEDIA_AUDIO` |
| Location                        | `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`                                                                                      |
| Package visibility and overlays | `QUERY_ALL_PACKAGES`, `SYSTEM_ALERT_WINDOW`                                                                                               |
| Microphone                      | `RECORD_AUDIO`                                                                                                                            |
| Calendar                        | `READ_CALENDAR`, `WRITE_CALENDAR`                                                                                                         |
| Sensors and activity            | `BODY_SENSORS`, `ACTIVITY_RECOGNITION`                                                                                                    |

**Not blocked yet, but recommended by the research (gap G-23):**

| Permission                                           | Why block it                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `android.permission.READ_MEDIA_VISUAL_USER_SELECTED` | Partial media access; the photo picker needs no permission, so the app never needs it.                                            |
| `android.permission.RECEIVE_WAP_PUSH`                | SMS-family permission.                                                                                                            |
| `android.permission.REQUEST_INSTALL_PACKAGES`        | Lets the app install other apps; never needed.                                                                                    |
| `com.google.android.gms.permission.AD_ID`            | Advertising identifier; added by some Google Play services and analytics libraries; block unless ad measurement is ever approved. |

**What CI checks today.** `.github/workflows/ci.yml` runs
`pnpm --filter @udofin/mobile config:check` with `APP_ENV=production`. That proves the production
configuration resolves; it does **not** inspect the merged Android manifest or iOS Info.plist. The
merged-manifest check in section 7.2 is planned for Phase 03.

---

## 4. Allowlist: permissions that may ever appear in a release build

Anything not listed here fails the planned CI check (section 7.2). "Conditional" entries are added
only when the condition is met and this table is updated in the same pull request.

| Permission (Android)               | iOS equivalent                                                      | Status                         | Condition and phase                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INTERNET`, `ACCESS_NETWORK_STATE` | none needed                                                         | Allowed                        | Install-time "normal" permissions.                                                                                                                                    |
| `VIBRATE`                          | none needed                                                         | Allowed                        | Added by the Expo template; no user data.                                                                                                                             |
| `POST_NOTIFICATIONS`               | Notification authorisation                                          | Conditional                    | Transactional repayment reminders, requested when the borrower taps "Turn on reminders" after sanction (Phase 08).                                                    |
| `RECEIVE_BOOT_COMPLETED`           | —                                                                   | Conditional                    | Only if `expo-notifications` is adopted (it adds this); review in Phase 08.                                                                                           |
| `USE_BIOMETRIC`                    | `NSFaceIDUsageDescription`                                          | Conditional                    | Only if an optional app lock is approved (Phase 05 or later).                                                                                                         |
| `CAMERA`                           | `NSCameraUsageDescription`                                          | Conditional                    | iOS document scanning (VisionKit) and, only if a lender's KYC policy requires it, selfie, liveness or video KYC (Phase 06). Not needed for Android document scanning. |
| `ACCESS_COARSE_LOCATION`           | `NSLocationWhenInUseUsageDescription` (reduced accuracy acceptable) | Conditional                    | Only if a lender's KYC, credit or fraud policy requires location; one time, at submission, with recorded consent (Phase 06).                                          |
| `RECORD_AUDIO`                     | `NSMicrophoneUsageDescription`                                      | Blocked; conditional exception | Only for lender-run video KYC if a lender requires it in Udofin's app. Needs removal from `blockedPermissions` in a separate, approved build path (Phase 06).         |

Intent visibility: if UPI apps must be opened for mandates or reverse penny drop, declare a
`<queries>` element for the `upi` scheme only. `QUERY_ALL_PACKAGES` stays blocked.

---

## 5. Permission plan per journey step

"None" means no runtime prompt. Phases follow [`../product/roadmap.md`](../product/roadmap.md).

| #   | Journey step (phase)                                                             | Permission Android / iOS                                                                                              | When requested                                             | Why                                                                   | Fallback if denied or unavailable                                                              | Policy reference                                                                                         | Enforcement                                                    |
| --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | Install, splash, language (03)                                                   | None (`INTERNET`, `ACCESS_NETWORK_STATE` are normal)                                                                  | —                                                          | Connectivity                                                          | —                                                                                              | Android permission model                                                                                 | Allowlist                                                      |
| 2   | Device integrity check (05)                                                      | None (`@expo/app-integrity`: Play Integrity / App Attest, verified server-side)                                       | Silently at first launch and before sensitive actions      | Fraud and tamper defence                                              | Tiered: allow with limits, step-up, or assisted channel; threshold is owner decision D-24      | Play Integrity documentation (confirmed)                                                                 | Server-side verdict check                                      |
| 3   | Mobile number (05)                                                               | None (Phone Number Hint on Android; `textContentType="telephoneNumber"` on iOS)                                       | On the number field                                        | Avoid typing errors                                                   | Manual entry                                                                                   | Play bans `READ_PHONE_NUMBERS` (confirmed)                                                               | `READ_PHONE_*` blocked                                         |
| 4   | Login OTP (05)                                                                   | None (SMS Retriever; the DLT-registered template carries the app hash; iOS `oneTimeCode` autofill)                    | On the OTP screen                                          | Auto-fill Udofin's OTP                                                | Manual entry and resend                                                                        | Play SMS/Call Log policy; Android SMS Retriever (confirmed)                                              | `READ_SMS`, `RECEIVE_SMS` blocked                              |
| 5   | Consents and loan request (05)                                                   | None                                                                                                                  | —                                                          | —                                                                     | —                                                                                              | RBI explicit consent (confirmed, secondary)                                                              | —                                                              |
| 6   | Third-party OTP: Aadhaar e-KYC or eSign, under the lender (06/07)                | None (SMS User Consent API: the borrower approves sharing one message; iOS `oneTimeCode`)                             | On the OTP screen                                          | Auto-fill an OTP whose text Udofin does not control                   | Manual entry                                                                                   | As row 4                                                                                                 | As row 4                                                       |
| 7   | PAN, CKYC and bureau checks under the lender's credentials (06)                  | None                                                                                                                  | Explicit consent screen per fetch, naming the lender       | Data comes from third parties, so consent must be explicit and logged | Proceed with manual entry where the lender allows                                              | Apple 5.1.1(viii) (confirmed); RBI consent                                                               | Consent id required by the API                                 |
| 8   | DigiLocker (06)                                                                  | None (OAuth in a Custom Tab / `ASWebAuthenticationSession`)                                                           | On "Fetch from DigiLocker"                                 | Verified documents without a camera                                   | Upload (row 9)                                                                                 | Apple 5.1.1(iii) (confirmed)                                                                             | —                                                              |
| 9   | Upload documents (06/07)                                                         | None (system photo picker or document picker)                                                                         | When the borrower taps Upload                              | Collect documents the lender requires                                 | Upload through the servicing web portal later (D-20)                                           | Play loan-app ban on storage and media (confirmed); Android photo picker needs no permission (confirmed) | Storage and `READ_MEDIA_*` blocked                             |
| 10  | Scan a paper document (06)                                                       | Android: none (ML Kit Document Scanner via Google Play services). iOS: camera (`NSCameraUsageDescription`, VisionKit) | When the borrower taps Scan                                | Clean document image                                                  | Upload (row 9) or DigiLocker (row 8); devices without Google Play services use the file picker | RBI one-time camera for KYC (likely); Apple 5.1.1(iv)                                                    | iOS usage string on allowlist                                  |
| 11  | Selfie, liveness or face match, only if the lender's KYC requires it (06)        | `CAMERA` / `NSCameraUsageDescription`                                                                                 | Once, at the selfie step, after an explanation screen      | KYC per the lender's policy                                           | Lender's video KYC or assisted/branch KYC; an accessible alternative to blink-based liveness   | RBI one-time camera with explicit consent (likely); Apple 2.5.14                                         | Conditional allowlist entry; consent record                    |
| 12  | Video KYC run by the lender, only if the lender requires it in Udofin's app (06) | `CAMERA`, `RECORD_AUDIO`, `ACCESS_COARSE_LOCATION`; iOS camera, microphone, location when in use                      | At the start of the video call                             | The lender must run its video KYC process                             | In-person KYC by the lender                                                                    | RBI one-time access (likely); Apple 2.5.14                                                               | Separate approved build path; `RECORD_AUDIO` otherwise blocked |
| 13  | Location, only if the lender's KYC, credit or fraud policy needs it (06)         | `ACCESS_COARSE_LOCATION` only; iOS when-in-use, reduced accuracy                                                      | Once, at application submission, with consent              | Serviceability or fraud check for the lender                          | Address from the KYC source; server-side IP geolocation                                        | Play bans fine location (confirmed); RBI one-time (likely); Apple 5.1.1(iv)                              | `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION` blocked   |
| 14  | Offer comparison, KFS, acceptance (06/07)                                        | None                                                                                                                  | —                                                          | —                                                                     | —                                                                                              | On iOS, offers above 36% APR hidden (Apple 3.2.2(ix), confirmed; owner decision D-19)                    | Server-side offer filter                                       |
| 15  | eSign and eStamp (07)                                                            | None (provider web flow, or a vendor SDK with prohibited permissions stripped)                                        | —                                                          | —                                                                     | Web signing through the servicing portal (D-20)                                                | Vendor manifest audit                                                                                    | Merged-manifest check                                          |
| 16  | Bank-account verification (07)                                                   | None (penny drop is server-side; reverse penny drop opens a UPI app through a `upi` intent)                           | —                                                          | —                                                                     | Penny drop instead of reverse penny drop                                                       | Play bans `QUERY_ALL_PACKAGES` (likely)                                                                  | `<queries>` for `upi` only                                     |
| 17  | eNACH or UPI AutoPay mandate (08)                                                | None (`<queries>` for `upi` only)                                                                                     | —                                                          | Repayment mandate                                                     | Net-banking or debit-card mandate in the browser                                               | As row 16                                                                                                | As row 16                                                      |
| 18  | One-time repayment (08)                                                          | None (gateway checkout in a Custom Tab or SDK)                                                                        | —                                                          | —                                                                     | Payment link opened in the browser                                                             | Vendor manifest audit                                                                                    | Merged-manifest check                                          |
| 19  | Repayment reminders (08)                                                         | `POST_NOTIFICATIONS` (Android 13+) / iOS notification authorisation                                                   | After sanction, when the borrower taps "Turn on reminders" | Due-date alerts                                                       | SMS or email from the server                                                                   | Apple 4.5.4 (confirmed); no personal or loan data in push payloads                                       | Conditional allowlist entry                                    |
| 20  | Marketing notifications (later)                                                  | Same OS permission **plus** a separate in-app marketing opt-in                                                        | Never at launch; only after an explicit opt-in screen      | Promotions                                                            | No marketing sent                                                                              | Apple 4.5.4 (confirmed); separate marketing consent                                                      | Consent check before sending                                   |
| 21  | Optional app lock (05 or later)                                                  | `USE_BIOMETRIC` / `NSFaceIDUsageDescription`                                                                          | When the borrower turns it on                              | Protect the session on a shared phone                                 | App PIN                                                                                        | Apple 5.1.2(i) (not mandatory)                                                                           | Conditional allowlist entry                                    |
| 22  | Grievance and Equator referral (09)                                              | None (in-app screens; Equator by link in a Custom Tab)                                                                | —                                                          | —                                                                     | Email or post to the lender's grievance officer                                                | Apple 5.1.1(i) related-entity disclosure (confirmed)                                                     | —                                                              |
| 23  | AI assistant (09)                                                                | None (text chat). `RECORD_AUDIO` only if voice input is ever approved, legally cleared and added to section 4         | —                                                          | —                                                                     | Human agent                                                                                    | Apple 5.1.2(i) third-party AI (confirmed)                                                                | `RECORD_AUDIO` blocked                                         |
| 24  | Collections and recovery (08)                                                    | **None, ever.** No contacts, call logs, photos or location tracking                                                   | —                                                          | —                                                                     | —                                                                                              | Play ban; RBI device-access rule; Apple 5.1.2(iv)–(v)                                                    | Blocked list                                                   |
| 25  | Personal "books of accounts" (not planned; owner decision D-22)                  | **No** `READ_SMS`. If ever built: Account Aggregator consent through a lender acting as FIU, by web redirect          | —                                                          | —                                                                     | Manual entry or statement upload                                                               | Play SMS policy; RBI device-access rule                                                                  | Blocked list                                                   |

---

## 6. Libraries and SDKs that add permissions by default

These come from reading the published packages on 2026-10-10 (confirmed, research §4–§6). Vendor
native SDKs (Android AARs) can add permissions that are invisible in npm, which is why the merged
manifest is the only reliable check.

| Source                                                               | What it adds                                                                                                                                                                                                                         | Handling                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expo SDK 57 prebuild template (`expo-template-bare-minimum` 57.0.29) | `INTERNET`, `SYSTEM_ALERT_WINDOW`, `VIBRATE`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE` (both maxSdk 32)                                                                                                                     | Storage and overlay permissions are blocked today.                                                                                                                                                                                      |
| `expo-image-picker` 57.0.20                                          | `CAMERA`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`; its plugin does not block them automatically                                                                                                                            | Storage is blocked. If the picker is used only for picking, block `CAMERA` too: an app that declares `CAMERA` but has not been granted it gets a `SecurityException` when launching the system camera intent (confirmed, Android docs). |
| `expo-location`                                                      | `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION`                                                                                                                                                                                  | Fine location stays blocked; coarse only if section 4 allows it.                                                                                                                                                                        |
| `expo-camera` 57.0.6                                                 | `CAMERA`; its config plugin adds `RECORD_AUDIO` by default (`recordAudioAndroid = true`)                                                                                                                                             | Set `recordAudioAndroid: false`; `RECORD_AUDIO` stays blocked.                                                                                                                                                                          |
| `expo-notifications` 57.0.22                                         | `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`                                                                                                                                                                                       | Allowed only when reminders ship (Phase 08).                                                                                                                                                                                            |
| KYC vendor SDKs                                                      | Digio's React Native SDK README asks integrators to add `ACCESS_FINE_LOCATION`, `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_MEDIA_AUDIO` and `RECORD_AUDIO` (confirmed). Other vendors (for example HyperVerge) were not checked. | Blocked list strips them; ask each vendor for a lending-safe configuration in writing; run the merged-manifest check on every SDK upgrade.                                                                                              |
| Root and jailbreak detection libraries                               | `jail-monkey` hook and mock checks rely on listing installed apps, which on Android 11+ returns little without `QUERY_ALL_PACKAGES` (confirmed)                                                                                      | Never add `QUERY_ALL_PACKAGES`; treat client-side root flags as a risk signal only.                                                                                                                                                     |
| Google Play services advertising or analytics libraries              | `com.google.android.gms.permission.AD_ID`                                                                                                                                                                                            | Add to the blocked list (G-23).                                                                                                                                                                                                         |

---

## 7. Enforcement

### 7.1 Today

- `android.permissions: []` and the 28-entry `android.blockedPermissions` list in
  `apps/mobile/app.config.ts` (section 3).
- `ios.infoPlist: {}`: no usage strings, so no iOS permission prompt can appear.
- CI resolves the production configuration (`config:check`), which catches a broken config but not
  a permission added by a library.
- The pull-request template asks whether the change adds permissions and requires this document to
  be updated if it does (`.github/pull_request_template.md`).

### 7.2 Planned: merged-manifest check in CI (Phase 03)

The release build, not the source configuration, is what Google Play reviews. The check therefore
runs on the built Android App Bundle:

1. Build the production profile (`eas.json` `production`, `APP_ENV=production`) in CI.
2. Extract the merged manifest from the bundle (for example `bundletool dump manifest --bundle=app-release.aab`) or list permissions from a universal APK (`aapt dump permissions`).
3. Fail the job if any `uses-permission` is not on the allowlist in section 4, or if any entry of the blocked list is present.
4. Fail if `targetSdkVersion` is below 36, or if `QUERY_ALL_PACKAGES` or a `<queries>` element other than the approved `upi` scheme appears.
5. Store the permission list as a build artefact; it is release evidence (checklist B-4) and feeds the Play Data safety form.

For iOS (when iOS starts), the equivalent job reads the built app's `Info.plist`, fails on any
`NS…UsageDescription` key not on the allowlist, and checks that the privacy manifest declares the
required-reason APIs used by the app and its SDKs (Apple requirement since 1 May 2024: confirmed).

### 7.3 Planned: runtime and code controls (Phases 05–06)

- One small module owns permission requests. It shows the explanation screen, records the consent
  decision, requests the permission once, and returns the result. Lint rules restrict imports of
  `expo-location`, `expo-camera` and similar modules to that module.
- The API refuses KYC steps that need camera or location evidence unless a matching consent record
  exists (one-time, explicit-consent evidence).
- Location and camera code paths are unreachable after the KYC stage (feature-flag test, research
  MS-08).

### 7.4 Store declarations

Every release compares the merged permission list and the SDK list with the Play Data safety form,
the Personal Loan App Declaration and Apple's privacy labels (checklist B-5).

---

## 8. Changing this plan

A new permission, usage string or permission-adding library needs, in one pull request:

1. The journey step, the purpose and why no permission-free alternative works.
2. The policy check against section 1 (RBI one-time rule, Play prohibited list, Apple guidelines).
3. The explanation-screen text and the consent notice version (from Phase 05, through `consent.notices`).
4. The fallback if the borrower says no.
5. Updates to section 4 (allowlist), section 5 (journey table), the Data safety form and Apple labels.
6. A test that the permission is requested only at that step, and the merged-manifest check passing.
7. Product owner approval. If the permission is on the Play prohibited list or barred by the RBI
   device-access rule, the answer is no.

---

## 9. Open questions

| Question                                                                                                                                                                                | Owner                      | Source                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------- |
| Will any launch lender require a selfie, liveness check or video KYC inside Udofin's app (and so `CAMERA`, possibly `RECORD_AUDIO` and coarse location), or run KYC in its own channel? | Product owner with lenders | app-store research, open question 4 |
| What Play Integrity threshold applies, given older or uncertified devices common in India?                                                                                              | Owner decision D-24        | app-store research, open question 6 |
| Is the 36% APR filter applied on iOS only or app-wide?                                                                                                                                  | Owner decision D-19        | app-store research, open question 3 |
| What exactly does Play Console accept from an LSP (non-licensee) in the Personal Loan App Declaration?                                                                                  | Product owner              | app-store research, open question 1 |
| Does `expo-secure-store` with `requireAuthentication` add any Android permission in SDK 57? Not checked in the research; verify on the first build that uses it.                        | Mobile lead                | unverified                          |

## Addendum (13 October 2026, Phase 03)

`expo-screen-capture` (used only to **block** screenshots on the one-time-code screen via `usePreventScreenCapture`) declares `android.permission.DETECT_SCREEN_CAPTURE` in its library manifest. We never detect screenshots, so the permission is added to `blockedPermissions` in `apps/mobile/app.config.ts` and stripped from the merged manifest. The Gradle-merged manifest of a release build has not been inspected in CI yet (needs the Android toolchain); `config:check` covers the declared configuration only.
