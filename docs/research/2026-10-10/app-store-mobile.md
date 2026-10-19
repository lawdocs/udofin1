# App-store policy and mobile engineering constraints for Udofin's borrower app (as of 2026-10-10)

**Executive summary.** Udofin's borrower app is a "personal loan app" under both Google Play and Apple rules because it facilitates unsecured loans from several lenders. Store policy, not only RBI, sets hard limits on it:

- **Google Play India.** Since 30 Oct 2025, Play onboards a new personal-loan app in India only if the app already appears on RBI's public "DLAs deployed by Regulated Entities" list. Existing apps had until 28 Jan 2026. The developer must also file the Personal Loan App Declaration with licence evidence. Udofin is an LSP and holds no RBI licence, so every partner RE must report the Udofin app (and any web front end) to RBI **before** launch.
- **Prohibited permissions.** Play bars loan, line-of-credit and lead-generator apps from photos, media and external storage, contacts, precise location and phone numbers. Current snippets also list QUERY_ALL_PACKAGES and WRITE_EXTERNAL_STORAGE.
- **Payday loans are effectively off both stores.** Play prohibits personal loans that must be repaid in full in 60 days or less. Apple prohibits the same and also caps APR at 36% including fees, worldwide, so the iOS app has to filter out any offer above 36% APR.
- **The owner's permission wish-list must change.** SMS reading becomes the SMS Retriever / User Consent APIs or iOS one-time-code autofill. Camera "KYC scanning" becomes the ML Kit Document Scanner, which needs no camera permission on Android, or DigiLocker. Location becomes coarse-only, one-time, and only where the RE needs it. Contacts and SMS-based "books of accounts" are dropped.
- **Expo can build this, but the defaults are not safe.** The current stack (Expo SDK 57 = React Native 0.86.3, New Architecture mandatory) works only with `android.blockedPermissions`. The Expo SDK 57 prebuild template and several Expo or vendor modules themselves add READ/WRITE_EXTERNAL_STORAGE, ACCESS_FINE_LOCATION, READ_MEDIA_* and RECORD_AUDIO.
- **OTA updates.** EAS Update is allowed in principle (Apple DPLA 3.3.1(B) lets an app download interpreted code under conditions). It still needs code-signing, change control and audit logging for regulated screens.
- **Web.** A borrower web channel is worth building, mainly for servicing, disclosures and iOS users. It counts as a DLA under RBI rules and is **not** a way around the store payday ban.

> **Research limitations (read first).** Two limits applied in this session. First, the shared web-search budget ran out partway through. Second, `support.google.com`, `play.google.com`, `docs.expo.dev`, `developers.google.com`, `rbi.org.in` and most news sites could not be fetched. As a result, Google Play policy text below comes from **search-result extracts of Google's own Help Center pages** (two or more independent queries where marked) and is not a full-page read. Apple pages (developer.apple.com) and Android docs (developer.android.com) were fetched directly. Expo and React Native facts were checked against the **published npm packages** (source, manifests, type definitions) downloaded on 2026-10-10. Before submission, someone should re-read the live Play "Financial Services" and "Personal loans in India" pages in Play Console.

---

## Findings

### 1. Google Play – Financial Services policy, Personal Loans

**1.1 Scope and definition.**

- **[confirmed – Google Help Center extract]** The policy covers apps that lend directly, lead generators, and apps that connect consumers with third-party lenders. That includes a multi-lender marketplace like Udofin. Source: [Financial Services – Play Console Help](https://support.google.com/googleplay/android-developer/answer/9876821) (accessed via search 2026-10-10).
- **[likely]** Play defines a personal loan as non-recurring lending to an individual consumer, not for buying a fixed asset or paying for education.
- **[likely]** Revolving credit (credit cards, personal lines of credit) is outside the _definition_. However, line-of-credit apps are still named in the sensitive-permission ban (see 1.3).
- **[interpretation]** Home and vehicle loans are arguably "fixed asset" financing and so outside the definition. LAP, LAS, medical, legal-expense, "debt reset", "resolution finance" and payday loans are personal loans. Because the app offers any personal loans, the whole app is treated as a personal-loan app.

**1.2 India-specific requirements.**

- **[confirmed – Google Help Center extract, two independent queries]** The [Personal loans in India](https://support.google.com/googleplay/android-developer/answer/16604194) page (accessed 2026-10-10) says:
  - _"As of October 30, 2025, all new personal loan apps which publish for the first time to Google Play will be required to be on the RBI list."_
  - _"All personal loan apps that are currently on Google Play in India will have until January 28, 2026 to have their app(s) included on the RBI list."_
  - Apps must _"hold and present a valid financial services license from the Reserve Bank of India (RBI)."_
- The Financial Services page adds: _"Only apps that submit a license and are on the 'Digital lending apps (DLAs) deployed by Regulated Entities' list of the Reserve Bank of India (RBI) may submit personal loan apps to Google Play for review."_
- Google attributes the list to the _"Reserve Bank of India (Digital Lending) Directions, 2025" (published on May 8, 2025)_, with REs to submit DLA details _"as of June 15, 2025."_
- **[confirmed – secondary/PIB extract]** RBI made the DLA directory operational with effect from 01.07.2025. Entries are self-reported by REs and are not an RBI endorsement. Source: [PIB press release PRID=2241255](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2241255) (via search; page not fetchable).
- **[likely – long-standing policy text, first introduced 2022–23, not re-read]** India declaration mechanics:
  - Developers complete the **Personal Loan App Declaration** in Play Console with supporting documents. A licensed lender submits its licence.
  - A facilitator that is not itself licensed must say so in the declaration.
  - The names of all partner NBFCs and banks must be shown prominently in the store description.
  - The developer account name must match the registered business named in the declaration.
- **[interpretation]** For an LSP, the "evidence" Play asks for in practice is:
  - each partner RE's RBI Certificate of Registration or licence;
  - the RE–LSP agreement or authorisation letter;
  - the RBI DLA directory entry showing the Udofin app's package and Play URL against each RE.

  Udofin cannot put itself on the directory. Only REs report DLAs to RBI.

- **[unverified]** A secondary count of about 1,067 apps in the directory as of Sept 2026 (gocredit.money) could not be checked against RBI.

**1.3 Prohibited permissions for personal-loan apps.**

- **[confirmed – 2023 launch list, multiple contemporaneous reports]** From 31 May 2023, personal-loan apps and lead generators may not request:
  - READ_EXTERNAL_STORAGE
  - READ_MEDIA_IMAGES
  - READ_CONTACTS
  - ACCESS_FINE_LOCATION
  - READ_PHONE_NUMBERS
  - "READ_MEDIA_VIDEOS" (the actual Android constant is `READ_MEDIA_VIDEO`)

  Sources: [TechCrunch, 5 Apr 2023](https://techcrunch.com/2023/04/05/google-personal-loan-apps-update/), [Business Today, 31 May 2023](https://www.businesstoday.in/tech-today/trending/story/google-to-restrict-personal-loan-apps-from-play-store-starting-today-383608-2023-05-31) (secondary). Digio's own SDK README reproduces the same list as _"A fintech Android app can't access the following permission"_ ([@digiotech/react-native 2.0.15 README](https://www.npmjs.com/package/@digiotech/react-native), 2026-06-19).

- **[likely – Google Help Center extract, two queries; not fetched]** The current page widens both the scope and the list:
  - Scope: _"Personal loan apps, apps with the primary purpose of facilitating access to personal loans (for example, lead generators or facilitators) or lines of credit, accessory loan or credit apps (loan calculators, loan guides, etc.), and Earned Wage Access (EWA) apps are prohibited from accessing sensitive data, such as photos and contacts."_
  - The list now also includes **QUERY_ALL_PACKAGES** and **WRITE_EXTERNAL_STORAGE**.
  - A secondary source dates this revision to enforcement on 27 Aug 2025 ([myappmonitor](https://myappmonitor.com/blog/google-play-personal-loans-policy-update), secondary).
- **Design rule:** treat all eight as banned. Also strip SMS, Call Log, phone-state and media permissions; Play restricts these separately, and RBI bars DLAs from accessing them.

**1.4 Short-tenor loans (the 60-day rule) and APR disclosure.**

- **[confirmed – Google Help Center extract; consistent since 2019]** Play does not allow apps that promote personal loans requiring repayment in full in **60 days or less** from issue.
- **[confirmed – Google Help Center extract]** Listings and apps must disclose:
  - the minimum and maximum repayment period;
  - the maximum APR;
  - **[likely]** a representative example of the total cost of the loan, and a privacy policy.
- **[confirmed]** The 36% APR prohibition is **US-only** on Play. India has no Play APR cap.
- **[unverified – secondary]** Google Ads separately allows personal-loan ads only for loans repayable in 61 days or more.
- **Conclusion on payday loans:**
  - **[confirmed]** A product requiring full repayment within 60 days cannot be listed or promoted in the Play app, whether as a direct product or as an offer from an RE in the marketplace.
  - **[confirmed]** It is also barred on the App Store (see §3).
  - **[interpretation]** Breaking a payday product into a 61-day-plus tenor technically clears the 60-day line. Its APR would still have to be disclosed. On iOS it would almost certainly breach the 36% APR cap. It also invites "circumvention" enforcement, and enforcement can hit the whole developer account.

**1.5 SMS and Call Log permissions.**

- **[confirmed – developer.android.com]** _"Google Play restricts apps' access to call- and messaging-related permission groups."_ An app must be the user's **default SMS/Phone handler** unless it meets a listed exception. Source: [Default handlers](https://developer.android.com/guide/topics/permissions/default-handlers) (accessed 2026-10-10), linking [Play Help 9047303](https://support.google.com/googleplay/android-developer/answer/9047303).
- **[confirmed]** For OTP, Android's guidance is: _"don't declare the `READ_SMS` permission. Instead, use the SMS Retriever API."_ Where the app does not control the SMS format, use the SMS User Consent API, which prompts the user to share _"only a single SMS message."_ Source: [Minimize permission requests](https://developer.android.com/privacy-and-security/minimize-permission-requests).
- **[confirmed]** From **27 Jan 2027**, the [SMS and Call Log policy](https://support.google.com/googleplay/android-developer/answer/10208820) will no longer accept account verification by phone call as a use of READ_CALL_LOG. The alternatives are the Digital Credentials API or SMS Retriever. Source: [Play policy timeline](https://developer.android.com/distribute/play-policies) (accessed 2026-10-10).
- **[unverified]** Whether a "financial SMS money-management" exception still exists. Even if it does, using it in a loan app would conflict with RBI's bar on DLAs accessing phone resources and would invite Play scrutiny. Not recommended.

**1.6 Other Play obligations.**

- **[confirmed – developer.android.com]** Target API:
  - From **31 Aug 2026**, new apps and updates must target **Android 16 (API 36)**. An extension to 1 Nov 2026 can be requested.
  - Existing apps must target API 35 to stay available to new users on newer devices.
  - Source: [Target API requirements](https://developer.android.com/google/play/requirements/target-sdk) (last updated 2026-10-01).
  - Expo SDK 57 / RN 0.86 defaults are minSdk 24, targetSdk 36, compileSdk 36, which complies (checked in the RN 0.86.3 `libs.versions.toml`).
- **[likely]** Data safety form:
  - Declare each data type collected and shared, including by SDKs: name, phone, address, government ID numbers, financial info and credit info, photos (selfie), approximate location, device IDs, app interactions.
  - Declare encryption in transit and a deletion-request mechanism.
  - Apps that let users create accounts must offer in-app and web account deletion. Legally required retention (e.g. under PMLA or RBI rules) may be disclosed as an exception.
  - The Play Help URLs for these could not be fetched this session.
- **[confirmed]** From 27 Jan 2027, Play introduces a Contacts Permissions policy (Android Contact Picker preferred). The location policy will recommend the Android 17 "location button" as the minimum scope for precise location (policy timeline above). Neither affects Udofin if contacts and fine location are never requested.
- **[confirmed]** Play Integrity API (see §5) has a default quota of 10,000 requests per day. Raising it requires the app to be on Play with its Cloud project linked. Source: [Play Integrity setup](https://developer.android.com/google/play/integrity/setup).

### 2. RBI overlay that drives the permission plan

**[likely – RBI Digital Lending Guidelines 2022, carried into the Digital Lending Directions 2025; not re-fetched here, so verify in the RBI-focused report]**

- DLAs must _"desist from accessing mobile phone resources like file and media, contact list, call logs, telephony functions, etc."_
- _"A one-time access can be taken for camera, microphone, location or any other facility necessary for the purpose of on-boarding/KYC requirements only, with the explicit consent of the borrower."_
- **[interpretation]** This is stricter than Play. Camera, microphone and location are allowed only for onboarding or KYC, once, with explicit consent. Continuous location, location for collections, and microphone for anything except V-CIP or an optional voice query to the AI agent fall outside it. Even the voice query needs legal review.

### 3. Apple App Store

- **[confirmed – fetched; guidelines "Last Updated: June 8, 2026"]** Guideline **3.2.2(ix)**: _"Apps offering personal loans must clearly and conspicuously disclose all loan terms, including but not limited to equivalent maximum Annual Percentage Rate (APR) and payment due date. Loan apps may not charge a maximum APR higher than 36%, including costs and fees, and may not require repayment in full in 60 days or less."_ Source: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).
  - This applies worldwide, India included.
  - Payday loans cannot be offered.
  - Any offer whose all-in APR, as calculated under RBI's KFS method, exceeds 36% must be suppressed on iOS.
- **[confirmed]** Guideline **5.1.1(ix)**: apps in _"banking and financial services"_ _"should be submitted by a legal entity that provides the services, and not by an individual developer."_ Use Udofin's organisation account. **[interpretation]** Apple, like Play, will ask for proof of RE partnerships.
- **[confirmed]** Other guidelines that bite here:
  - **5.1.1(iii)** data minimisation: use out-of-process pickers.
  - **5.1.1(iv)** offer alternatives when a permission is denied (e.g. manual address entry).
  - **5.1.1(v)** in-app account deletion.
  - **5.1.1(viii)**: _"Apps that compile personal information from any source that is not directly from the user or without the user's explicit consent, even public databases, are not permitted."_ Bureau pulls, CKYC download and DigiLocker fetch each need explicit, logged consent.
  - **5.1.2(i)**: disclose and obtain explicit permission before sharing personal data _"with third parties, including with third-party AI"_. This covers the AI agent.
  - **5.1.2(i)** also: no gating of functionality on location, push or tracking.
  - **5.1.2(iv)–(v)**: no contact databases and no contacting people found via Contacts.
  - **4.5.4**: marketing pushes only after explicit in-app opt-in plus an in-app opt-out, and push _"should not be used to send sensitive personal or confidential information."_
  - **2.3.1**: no hidden or dormant features; _"All new features ... must be described with specificity in the Notes for Review."_
  - **2.5.14**: recording consent and indicator (applies to V-CIP or selfie video).
- **[confirmed]** ATT: _"Tracking"_ means linking data with other companies' data for ads, or sharing with data brokers. These are **not** tracking:
  - sharing with a data broker _"solely for fraud detection, fraud prevention, or security purposes"_;
  - sharing with a consumer reporting agency for creditworthiness reporting or credit decisions.

  Feature gating on ATT consent is prohibited. Apple also states _"you may not derive data from a device for the purpose of uniquely identifying it"_ (fingerprinting), which constrains how fraud SDKs may be configured on iOS. Source: [User Privacy and Data Use](https://developer.apple.com/app-store/user-privacy-and-data-use/). **[interpretation]** With no ad or attribution SDKs, Udofin needs no ATT prompt.

- **[confirmed]** Privacy manifests: since 1 May 2024, approved reasons are needed for required-reason APIs, including those in SDKs. Listed SDKs (including **hermes**, Firebase and others) must ship manifests and signatures. Expo exposes `ios.privacyManifests` in app config (checked in `@expo/config-types`). Sources: [Upcoming requirements](https://developer.apple.com/news/upcoming-requirements/), [Third-party SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/).
- **[confirmed]** Builds uploaded since **28 Apr 2026** must use **Xcode 26 / iOS 26 SDK**. New age-rating questions became mandatory on 31 Jan 2026 ([Upcoming requirements](https://developer.apple.com/news/upcoming-requirements/)). EAS Build images must be on Xcode 26 or later.

### 4. OTP, document capture, KYC camera and liveness

- **OTP on Android.**
  - **[confirmed]** The SMS Retriever API needs no SMS permission. Play services delivers a matching SMS for up to 5 minutes; the SMS must carry an app-identifying hash; and _"You must perform verification of the one-time code on your server"_ ([SMS Retriever](https://developer.android.com/identity/sms-retriever)).
  - **[confirmed – package source]** `@pushpendersingh/react-native-otp-verify` 1.2.0 (New-Arch codegen, empty manifest, _"Zero-permission SMS verification using Google's SMS Retriever API"_) works in Expo dev builds. `expo-sms-retriever` (0.1.1, 2024) is stale. ([npm](https://www.npmjs.com/package/@pushpendersingh/react-native-otp-verify), 2025-10-15)
  - **[interpretation]** Use SMS Retriever for Udofin's own login OTP, because Udofin controls the template (DLT-registered with the hash).
  - **[interpretation]** For OTPs whose SMS text Udofin does not control (UIDAI Aadhaar OTP, eSign OTP, bank OTPs), use the SMS User Consent API or manual entry.
  - **[confirmed – RN source]** RN `TextInput` maps `autoComplete="one-time-code"` to Android `sms-otp` autofill.
- **OTP on iOS.** **[confirmed – RN source; Apple page not renderable]** `textContentType="oneTimeCode"` enables the QuickType one-time-code suggestion with no permission.
- **Phone number.**
  - **[confirmed]** Use the Phone Number Hint library instead of READ_PHONE_STATE or READ_PHONE_NUMBERS ([Minimize permission requests](https://developer.android.com/privacy-and-security/minimize-permission-requests)).
  - **[confirmed – unclear for India]** Android's Digital Credentials phone-number verification (TS.43 carrier token through an aggregator; Android 10+; library at 1.7.0-alpha03) is an emerging option. Carrier and country coverage is not stated, so India support is unknown ([page](https://developer.android.com/identity/digital-credentials/phone-number-verification)).
- **Document scanning.**
  - **[confirmed – package source]** `react-native-document-scanner-plugin` 2.0.4 (2026-01-02) uses `play-services-mlkit-document-scanner:16.0.0` on Android and VisionKit `VNDocumentCameraViewController` on iOS. It ships an Expo config plugin and supports New-Arch codegen. Its README says Android needs no camera permission; its Android manifest declares none. iOS needs `NSCameraUsageDescription`. It does not run in Expo Go ([npm](https://www.npmjs.com/package/react-native-document-scanner-plugin)).
  - **[likely]** The ML Kit scanner UI and models are delivered by Google Play services, so it fails on non-GMS devices. Fall back to the system file picker.
- **Photo and file upload.**
  - **[confirmed]** The Android photo picker _"doesn't require any runtime permissions"_. It works natively on Android 11+, is backported to API 19+ via Google Play services, and falls back to `ACTION_OPEN_DOCUMENT` ([Photo picker](https://developer.android.com/training/data-storage/shared/photo-picker)).
  - **[confirmed – package source]** `expo-image-picker` 57.0.20 uses `PickVisualMedia` and includes the backport service. **However, its library manifest declares CAMERA plus READ_EXTERNAL_STORAGE and WRITE_EXTERNAL_STORAGE (maxSdk 32)**, and its plugin comment admits these are not auto-blocked.
- **Camera.**
  - **[confirmed]** Android warns that if an app declares CAMERA and the user has not granted it, launching `ACTION_IMAGE_CAPTURE` throws `SecurityException` ([Minimize permission requests](https://developer.android.com/privacy-and-security/minimize-permission-requests)).
  - **[confirmed – package source]** `expo-camera` 57.0.6 declares CAMERA. Its config plugin adds RECORD_AUDIO by default (`recordAudioAndroid = true`), so set it to `false`.
- **Liveness and face match.**
  - **[confirmed – npm]** Indian KYC vendor SDKs exist as React Native wrappers: HyperVerge `react-native-hyperkyc-sdk` 2.7.0 (2026-03-25) and Digio `@digiotech/react-native` 2.0.15 (2026-06-19).
  - **[confirmed]** Digio's README asks integrators to add ACCESS_FINE_LOCATION, READ_MEDIA_IMAGES, READ_MEDIA_VIDEO, READ_MEDIA_AUDIO and RECORD_AUDIO. Three of these are Play-prohibited for loan apps, so they must be stripped and the vendor asked for a "lending-safe" configuration.
  - **[confirmed – npm]** AWS Amplify Face Liveness ships for React web (`@aws-amplify/ui-react-liveness` 3.7.0). Azure ships a Face Liveness **web** SDK (`@azure/ai-vision-face-ui` 1.5.1).
  - **[interpretation]** For a pure-Expo build, prefer one of:
    - a vendor native SDK with an Expo config plugin (dev build); or
    - a vendor-hosted web liveness flow in a WebView or Custom Tab. This needs CAMERA granted to the app plus WebView media permission handling.
  - **[interpretation]** Whether a selfie or liveness check is needed at all is the **RE's** KYC decision. Aadhaar OTP e-KYC plus CKYC may not require it. Accessibility alternatives to "blink" liveness are needed (see §8).

### 5. Device attestation, root/jailbreak detection, pinning and secure storage

- **Attestation.**
  - **[confirmed – package source]** Expo now ships a first-party module, **`@expo/app-integrity` 57.0.2** (first published July 2025). It wraps:
    - iOS **App Attest**: `isSupported`, `generateKeyAsync`, `attestKeyAsync`, `generateAssertionAsync`;
    - Android **Play Integrity standard requests**: `prepareIntegrityTokenProviderAsync`, `requestIntegrityCheckAsync(requestHash)`;
    - Android hardware key attestation: `generateHardwareAttestedKeyAsync`, `getAttestationCertificateChainAsync`.

    Note: it is _not_ listed in `expo/bundledNativeModules.json`, so pin the version deliberately.

  - **[confirmed]** Play Integrity verdict tiers are `MEETS_STRONG_INTEGRITY`, `MEETS_DEVICE_INTEGRITY` and `MEETS_BASIC_INTEGRITY`. Opt-in signals include app access risk (overlay or screen-capture apps), Play Protect status and recent device activity. Google advises tiered enforcement, not caching verdicts, and not using it _"as your sole anti-abuse mechanism"_ ([Play Integrity overview](https://developer.android.com/google/play/integrity/overview), last updated 2026-04-20).
  - **[recommendation]** Bind `requestHash` to the action payload (offer ID, amount, bank account, mandate ID) at offer acceptance, eSign start, bank-account change and mandate creation.
- **Root/jailbreak detection.**
  - **[confirmed – package source]** `jail-monkey` 3.0.0 (New-Arch codegen) offers `isJailBroken`, `canMockLocation`, `hookDetected` and `AdbEnabled`. Its hook and mock checks call `getInstalledApplications`. On Android 11+ that returns little without QUERY_ALL_PACKAGES, which **must not** be added (Play-prohibited for loan apps per 1.3).
  - `freerasp-react-native` 5.2.3 (Talsec) is an alternative. Disable any malware-scan feature that needs broad package visibility.
  - **[recommendation]** Treat client-side root and jailbreak flags as risk signals; server-verified Play Integrity and App Attest are authoritative.
- **Certificate pinning.**
  - **[confirmed – package source]** `react-native-ssl-public-key-pinning` 1.2.6 (OkHttp `CertificatePinner` / TrustKit, New-Arch codegen) is documented for the Expo managed workflow through dev and production builds. On iOS dev builds, the expo-dev-client network inspector must be disabled.
  - **[interpretation]** It pins RN networking only. `expo-updates` fetches with its own native client, so rely on EAS Update **code signing** to protect that path.
  - **[recommendation]** Pin only Udofin's own API gateway domain, not Supabase or vendor domains whose certificates rotate, and always ship backup pins.
- **Secure storage.**
  - **[confirmed – package source]** `expo-secure-store` 57.0.4 uses the iOS Keychain with accessibility constants (use `WHEN_UNLOCKED_THIS_DEVICE_ONLY`) and the Android Keystore.
  - `requireAuthentication` gates reads behind biometrics; keys are invalidated when biometrics change.
  - Its config plugin writes Android backup and data-extraction exclusion rules.
  - **[recommendation]** Store only session and refresh tokens and a device-binding key handle. Never store Aadhaar or PAN numbers, KYC images or bureau data on the device. Use `expo-screen-capture` (in SDK 57) to block screenshots on KYC, KFS and bank screens.

### 6. Expo SDK, the New Architecture and permission stripping

- **[confirmed – npm]**
  - `expo` 57.0.27 (published 2026-10-06) pins **react-native 0.86.3**, React 19.2.3 and react-native-web ~0.21.0 (`bundledNativeModules.json`).
  - npm's newest react-native is 0.87.1 (2026-08-26). Do **not** upgrade React Native outside the Expo SDK pairing.
- **[confirmed – RN source]** The New Architecture is mandatory:
  - In RN 0.86.3, `NewArchitectureHelper.new_arch_enabled` returns `true` unconditionally.
  - The Android legacy path throws _"Legacy architecture of React Native is deprecated and can't be initialized anymore."_
  - `newArchEnabled` no longer appears in Expo config types.
  - Every native library must support TurboModules/Fabric. The libraries named above ship `codegenConfig`; `react-native-otp-verify` (faizalshap) does not.
- **[confirmed – package source] Hidden permission sources in a default Expo build:**

  | Source                                                                             | Permissions it adds                                                                                            |
  | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
  | Expo SDK 57 prebuild template (`expo-template-bare-minimum` 57.0.29) main manifest | INTERNET, SYSTEM_ALERT_WINDOW, VIBRATE, **READ_EXTERNAL_STORAGE**, **WRITE_EXTERNAL_STORAGE** (both maxSdk 32) |
  | `expo-image-picker`                                                                | CAMERA, READ/WRITE_EXTERNAL_STORAGE                                                                            |
  | `expo-location`                                                                    | **ACCESS_FINE_LOCATION** and COARSE                                                                            |
  | `expo-camera` plugin                                                               | RECORD_AUDIO by default                                                                                        |
  | `expo-notifications`                                                               | POST_NOTIFICATIONS, RECEIVE_BOOT_COMPLETED                                                                     |

- **[confirmed – `@expo/config-plugins` 57.0.10 source]** `android.blockedPermissions` writes `<uses-permission tools:node="remove">` into the final manifest. _"This is useful for removing permissions that are added by native package AndroidManifest.xml files."_ It is not available in Expo Go. Use dev builds (`expo-dev-client`) throughout.
- **[recommendation]** Add a CI gate on the release AAB that fails if any banned permission appears in the **merged** manifest. Vendor AARs (KYC, eSign, analytics) add permissions that are invisible in npm.

### 7. EAS Build, Submit and Update (OTA) in a regulated app

- **[confirmed – Apple DPLA §3.3.1(B), fetched]** _"Interpreted code may be downloaded to an Application but only so long as such code: (a) does not change the primary purpose of the Application by providing features or functionality that are inconsistent with the intended and advertised purpose of the Application (b) does not bypass signing, sandbox, or other security features of the OS; and (c) ... does not create a store or storefront."_ ([DPLA](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/)) Guidelines 2.5.2 and 2.3.1 also apply.
- **[likely – Play "Device and Network Abuse"; not fetched]** A Play app may not update itself outside Play's update mechanism or download executable code (dex, JAR, .so). Code that runs in a VM or interpreter with indirect access to Android APIs (e.g. JavaScript) is exempt.
- **[interpretation]** EAS Update's JS/Hermes bundles are widely shipped under these exceptions. OTA must still never add a new loan product, a new data collection, new permission use, or a change to APR or KFS logic.
- **[confirmed – `@expo/config-types` / `expo-updates` 57.0.25] Configuration controls:**

  | Control                                                                               | What it does                                                   |
  | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
  | `updates.codeSigningCertificate` / `codeSigningMetadata`                              | All updates must be signed                                     |
  | `runtimeVersion` policy `fingerprint`                                                 | Ties updates to compatible native code                         |
  | `checkAutomatically: ON_ERROR_RECOVERY \| NEVER \| WIFI_ONLY \| ON_LOAD`              | Controls when the app checks for updates                       |
  | `fallbackToCacheTimeout`                                                              | How long launch waits for a new update                         |
  | Runtime constants `Updates.updateId`, `channel`, `runtimeVersion`, `isEmbeddedLaunch` | Lets each consent and audit event record exactly what code ran |

### 8. Accessibility and multilingual support

- **[likely – w3.org not fetchable]** WCAG 2.2 became a W3C Recommendation on 5 Oct 2023. New success criteria relevant here:
  - 2.4.11 Focus Not Obscured (AA)
  - 2.5.7 Dragging Movements (AA)
  - 2.5.8 Target Size Minimum (AA, 24×24 CSS px)
  - 3.2.6 Consistent Help (A): grievance and help entry point in the same place on every screen
  - 3.3.7 Redundant Entry (A): do not re-ask for PAN or address already fetched from DigiLocker or CKYC
  - 3.3.8 Accessible Authentication (AA): allow OTP paste and autofill, no cognitive CAPTCHA

  4.1.1 Parsing is obsolete. Also apply 2.2.1 Timing Adjustable to OTP and eSign timeouts.

- **[unverified in this session]** India context to confirm with counsel:
  - the RPwD Act 2016;
  - the Supreme Court's 30 Apr 2025 _Pragya Prasun_ judgment directing accessible digital KYC (alternatives to blink-based liveness).
- **[likely]** RBI requires KFS and loan documents in a language the borrower understands.
- **[recommendation]** Multilingual implementation:
  - Use `expo-localization` (in SDK 57) with an i18n library, and keep server-versioned legal text per language.
  - Bundle Noto Indic fonts.
  - Format amounts with `Intl` `en-IN` / `hi-IN` (lakh/crore grouping).
  - Test with TalkBack and VoiceOver in Hindi.
  - If Urdu is ever added, support RTL.
  - Localise both store listings.

### 9. Should Udofin also run a borrower web experience?

- **[likely]** RBI's DLA definition covers mobile **and web-based** applications. A Udofin borrower web portal is therefore a DLA. Each RE must report it, and it must show the same disclosures (RE names, KFS, grievance officer, cooling-off).
- **[interpretation]** Web is not bound by Play or App Store product rules, but RBI rules, Google Ads policy and reputational risk still apply. It is **not** a sanctioned route for payday or above-36% offers that the stores forbid. Steering iOS users from the app to such offers on the web also risks App Review action under 2.3.1 and 5.6.
- **[recommendation]** Build web in this order:
  1. A public website (Next.js) with RE list, DLA links, grievance and policies.
  2. A responsive borrower **servicing** portal: KFS and sanction letter, statements, foreclosure, mandate management, grievance and Equator escalation, data-rights requests.
  3. Web origination later.

  Why Next.js for web rather than Expo web:
  - better SSR/SEO and CSP and cookie-session control;
  - the operations and RE portals are already web apps;
  - native-only modules (`@expo/app-integrity`, document scanner, secure-store) do not run on web.

  Share a TypeScript domain package (schemas, KFS display, i18n strings) with the Expo app. On web, replace device attestation with bot and risk controls (reCAPTCHA Enterprise or Turnstile), WebAuthn/passkeys and server-side risk scoring.

### 10. Permission plan per journey step

Android names are `android.permission.*` unless stated. "None" means no runtime prompt.

| #   | Journey step                                                             | Permission (Android / iOS)                                                                                                                       | When requested                                        | Why                                                                   | Fallback if denied / unavailable                                                                                     | Policy reference                                                |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | Install, splash, language choice                                         | None (INTERNET, ACCESS_NETWORK_STATE are install-time "normal")                                                                                  | —                                                     | Connectivity                                                          | —                                                                                                                    | Android permissions overview                                    |
| 2   | Device risk check                                                        | None (`@expo/app-integrity`: Play Integrity / App Attest)                                                                                        | Silently at first launch and before sensitive actions | Fraud and tamper defence                                              | Tiered: allow with limits, step-up OTP, or assisted channel; never hard-block only on BASIC integrity without review | Play Integrity overview; RBI DL (fraud controls)                |
| 3   | Mobile number                                                            | None (Phone Number Hint on Android; `textContentType=telephoneNumber` on iOS)                                                                    | On number field                                       | Avoid typing errors                                                   | Manual entry                                                                                                         | Minimize permission requests; Play prohibits READ_PHONE_NUMBERS |
| 4   | Login OTP                                                                | None (SMS Retriever + app hash in DLT template; iOS `oneTimeCode`)                                                                               | On OTP screen                                         | Auto-fill OTP                                                         | Manual entry, resend, voice OTP from server                                                                          | Play SMS/Call Log policy; Android SMS Retriever                 |
| 5   | Aadhaar OTP / eSign OTP (template not controlled by Udofin)              | None (SMS User Consent: one-message user prompt; iOS `oneTimeCode`)                                                                              | On OTP screen                                         | Auto-fill third-party OTP                                             | Manual entry                                                                                                         | As above                                                        |
| 6   | PAN, CKYC, bureau soft pull                                              | None                                                                                                                                             | Explicit consent screen per fetch                     | Data comes from third parties, so consent must be explicit and logged | Manual entry; proceed without bureau offer                                                                           | Apple 5.1.1(viii); ATT CRA exemption; RBI consent               |
| 7   | DigiLocker                                                               | None (OAuth via `expo-web-browser` Custom Tab / ASWebAuthenticationSession)                                                                      | On "Fetch from DigiLocker"                            | Verified documents without camera                                     | Upload via picker (step 8)                                                                                           | Apple 5.1.1(iii)                                                |
| 8   | Upload documents (bank statement PDF, property papers)                   | None (system document picker or photo picker; **block** READ/WRITE_EXTERNAL_STORAGE, READ_MEDIA_*)                                               | When user taps Upload                                 | Collect required documents                                            | Email or web upload via servicing portal                                                                             | Play loan-permission ban; Photo picker docs                     |
| 9   | Scan a paper document                                                    | Android: none (ML Kit Document Scanner). iOS: Camera (`NSCameraUsageDescription`, VisionKit)                                                     | When user taps Scan                                   | Clean document image                                                  | Upload (8) or DigiLocker (7)                                                                                         | RBI one-time camera for KYC; Apple 5.1.1(iv)                    |
| 10  | Selfie / liveness / face match (only if the RE's KYC policy requires it) | CAMERA / `NSCameraUsageDescription`                                                                                                              | At the selfie step, once, after explaining            | KYC per RE                                                            | V-CIP or branch/assisted KYC; accessible non-blink liveness                                                          | RBI one-time access; Apple 2.5.14                               |
| 11  | V-CIP (RE-run video KYC, if used)                                        | CAMERA, RECORD_AUDIO (enable `recordAudioAndroid` only in this build path), ACCESS_COARSE_LOCATION; iOS camera, microphone, location when in use | At V-CIP start                                        | RE must geo-tag and confirm the borrower is in India                  | In-person KYC by the RE                                                                                              | RBI KYC MD (RE obligation); Apple 2.5.14                        |
| 12  | Location (only if the RE's credit or fraud policy needs it)              | **ACCESS_COARSE_LOCATION only**; **block FINE and BACKGROUND**; iOS when-in-use (reduced accuracy acceptable)                                    | One time, at application submit, with consent         | Serviceability, fraud                                                 | Use the Aadhaar/CKYC address; server IP geolocation                                                                  | Play prohibits FINE; RBI one-time; Apple 5.1.1(iv)              |
| 13  | Offer comparison, KFS, accept                                            | None                                                                                                                                             | —                                                     | —                                                                     | —                                                                                                                    | iOS: hide offers above 36% APR; Play: show APR and tenor range  |
| 14  | eSign + eStamp                                                           | None (ESP web flow or vendor SDK with banned permissions stripped)                                                                               | —                                                     | —                                                                     | Web eSign through the servicing portal                                                                               | Vendor manifest audit                                           |
| 15  | eNACH / UPI Autopay                                                      | None (`<queries>` for the `upi://` intent scheme only; **no** QUERY_ALL_PACKAGES)                                                                | —                                                     | Repayment mandate                                                     | Net-banking or debit-card mandate in browser                                                                         | Play loan-permission ban (QUERY_ALL_PACKAGES)                   |
| 16  | Repayment reminders (transactional)                                      | POST_NOTIFICATIONS (Android 13+) / iOS notification authorisation                                                                                | After sanction, on "Turn on reminders"                | EMI due alerts                                                        | SMS, email or WhatsApp from server (DLT-compliant)                                                                   | Apple 4.5.4 (no sensitive data in push)                         |
| 17  | Marketing notifications                                                  | Same OS permission **plus** a separate in-app marketing opt-in toggle                                                                            | Never at launch; only with an explicit opt-in screen  | Promotions                                                            | No marketing sent                                                                                                    | Apple 4.5.4; DPDP consent (other report)                        |
| 18  | App lock                                                                 | USE_BIOMETRIC (normal) / `NSFaceIDUsageDescription`                                                                                              | When the user enables it                              | Protect session                                                       | App MPIN                                                                                                             | Apple 5.1.2(i) (not mandatory)                                  |
| 19  | "Books of accounts" / expense view                                       | **No READ_SMS**; Account Aggregator consent (web redirect) or manual entry                                                                       | When the user opts in                                 | Cash-flow view                                                        | Manual entry, statement upload                                                                                       | Play SMS policy; RBI DL phone-resources bar                     |
| 20  | AI help agent                                                            | None (RECORD_AUDIO only if voice input is added and legally cleared)                                                                             | —                                                     | —                                                                     | Text chat; human agent                                                                                               | Apple 5.1.2(i) third-party-AI disclosure                        |
| 21  | Grievance → Equator ADR                                                  | None (in-app link or Custom Tab)                                                                                                                 | —                                                     | —                                                                     | Email or post grievance to the RE's GRO                                                                              | Apple 5.1.1(i) related-entity disclosure                        |
| 22  | Collections                                                              | **None**: never contacts, call logs, photos or location tracking                                                                                 | —                                                     | —                                                                     | —                                                                                                                    | Play ban; RBI DL; Apple 5.1.2(iv)–(v)                           |

**Recommended `app.config` `android.blockedPermissions`** for the production profile:

- Storage and media: READ_EXTERNAL_STORAGE, WRITE_EXTERNAL_STORAGE, MANAGE_EXTERNAL_STORAGE, READ_MEDIA_IMAGES, READ_MEDIA_VIDEO, READ_MEDIA_AUDIO, READ_MEDIA_VISUAL_USER_SELECTED
- Contacts and accounts: READ_CONTACTS, WRITE_CONTACTS, GET_ACCOUNTS
- Location: ACCESS_FINE_LOCATION, ACCESS_BACKGROUND_LOCATION
- Phone: READ_PHONE_NUMBERS, READ_PHONE_STATE, CALL_PHONE, READ_CALL_LOG, WRITE_CALL_LOG, PROCESS_OUTGOING_CALLS
- SMS: READ_SMS, RECEIVE_SMS, SEND_SMS, RECEIVE_MMS, RECEIVE_WAP_PUSH
- Other: QUERY_ALL_PACKAGES, REQUEST_INSTALL_PACKAGES, SYSTEM_ALERT_WINDOW, RECORD_AUDIO (unless the V-CIP build needs it), `com.google.android.gms.permission.AD_ID` (unless ads measurement is approved)

---

## Requirements-to-controls

| ID    | Requirement                                                                                                                                                        | Source (instrument + para/section if verified)                                     | Applies to                                            | Status                      | System control in Udofin                                                                                                                              | Evidence to retain                                          | Test case                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| MS-01 | Personal-loan app must be on RBI "DLAs deployed by REs" list before Play onboarding (new apps from 30 Oct 2025)                                                    | Play Help "Personal loans in India" (16604194); Financial Services (9876821)       | RE (reports to RBI); LSP (Play declaration); platform | confirmed (extract)         | Launch gate: no production release until every live RE's directory entry is screenshotted and matched to package name `com.udofin...` and the web URL | Directory screenshots, RE confirmation emails, date-stamped | Release pipeline blocks if `dla_registry_verified=false` for any RE with live offers |
| MS-02 | Personal Loan App Declaration with licence and partner evidence; RE names in listing; account name = registered entity                                             | Play Financial Services (India section)                                            | LSP                                                   | likely                      | Play Console organisation account under Udofin's legal name; listing template auto-lists active REs                                                   | Declaration PDF, RE CoRs, LSP agreements                    | Listing diff check each release: REs in listing = active REs in DB                   |
| MS-03 | No READ_EXTERNAL_STORAGE, WRITE_EXTERNAL_STORAGE, READ_MEDIA_IMAGES, READ_MEDIA_VIDEO, READ_CONTACTS, ACCESS_FINE_LOCATION, READ_PHONE_NUMBERS, QUERY_ALL_PACKAGES | Play Financial Services – Personal Loans                                           | LSP (app owner)                                       | confirmed (6) / likely (+2) | `android.blockedPermissions` plus CI merged-manifest scan of the AAB                                                                                  | CI logs per build; `aapt dump permissions` output           | Build fails if any banned permission is present                                      |
| MS-04 | No loans with full repayment ≤60 days in app                                                                                                                       | Play Financial Services; Apple 3.2.2(ix)                                           | LSP; RE (product)                                     | confirmed                   | Product catalogue flag `min_tenor_days >= 61` enforced server-side for mobile channels                                                                | Product config history                                      | API rejects mobile offer with tenor ≤60d                                             |
| MS-05 | iOS: max APR ≤36% incl. costs and fees; disclose APR and due date                                                                                                  | Apple 3.2.2(ix)                                                                    | LSP                                                   | confirmed                   | Offer filter `platform=ios AND apr_all_in<=36`; APR from RBI KFS method                                                                               | Offer-filter logs; APR calc version                         | Seed offer at 36.01% APR is hidden on iOS                                            |
| MS-06 | Disclose min/max repayment period, max APR, representative cost example                                                                                            | Play Financial Services                                                            | LSP                                                   | confirmed / likely          | Store listing and in-app product pages generated from product config                                                                                  | Listing snapshots per release                               | Listing values = DB values                                                           |
| MS-07 | No READ_SMS / Call Log; OTP through SMS Retriever / User Consent                                                                                                   | Play SMS & Call Log policy (10208820); Android "Minimize permission requests"      | LSP                                                   | confirmed                   | OTP module uses the retriever; DLT template includes app hash                                                                                         | Template registration, code review                          | Fresh install: OTP autofills with no SMS permission in Settings                      |
| MS-08 | RBI: only one-time camera, mic or location for onboarding/KYC, with explicit consent                                                                               | RBI DL Guidelines 2022 / DL Directions 2025 (para not verified here)               | RE + LSP                                              | likely                      | Permission requests only inside KYC steps; consent record with timestamp and purpose; no later reuse                                                  | Consent logs                                                | Location API cannot be called after the KYC stage (feature flag test)                |
| MS-09 | Target API 36 for new apps and updates from 31 Aug 2026                                                                                                            | Android target-SDK page                                                            | LSP                                                   | confirmed                   | Expo SDK 57 defaults targetSdk 36; CI asserts it                                                                                                      | Build metadata                                              | `targetSdkVersion==36` check                                                         |
| MS-10 | iOS built with Xcode 26 / iOS 26 SDK                                                                                                                               | Apple Upcoming Requirements (since 28 Apr 2026)                                    | LSP                                                   | confirmed                   | EAS build image pinned to Xcode 26+                                                                                                                   | eas.json, build logs                                        | Upload accepted by App Store Connect                                                 |
| MS-11 | Privacy manifest with required reasons; SDK manifests                                                                                                              | Apple Upcoming Requirements (1 May 2024); Third-party SDK list                     | LSP                                                   | confirmed                   | `ios.privacyManifests` in app config; Xcode privacy report reviewed per release                                                                       | Privacy report PDF                                          | No ITMS-91053 warnings on upload                                                     |
| MS-12 | Data safety form and Apple privacy labels accurate, including SDK data                                                                                             | Play Data safety (URL not verified); Apple 5.1.1(i)                                | LSP                                                   | likely / confirmed          | Data inventory register mapped to each SDK; quarterly review                                                                                          | Signed data-map, form snapshots                             | Diff of the SDK list vs the data map                                                 |
| MS-13 | Explicit consent before compiling data from third parties (bureau, CKYC, DigiLocker)                                                                               | Apple 5.1.1(viii); RBI DL                                                          | LSP + RE                                              | confirmed (Apple)           | Per-source consent screens; consent ID passed to the API call                                                                                         | Consent artefacts                                           | Bureau API call without a consent ID is rejected                                     |
| MS-14 | Disclose and get permission before sharing data with third-party AI                                                                                                | Apple 5.1.2(i)                                                                     | LSP                                                   | confirmed                   | AI agent opt-in screen; PII redaction before the LLM call; vendor named in privacy policy                                                             | Opt-in logs, DPA with AI vendor                             | Agent unavailable until opt-in is recorded                                           |
| MS-15 | Marketing push only with explicit in-app opt-in plus opt-out; no sensitive data in push                                                                            | Apple 4.5.4                                                                        | LSP                                                   | confirmed                   | Separate `marketing_push` consent; push templates without amounts or account numbers                                                                  | Consent logs, template review                               | Marketing push suppressed for users who have not opted in                            |
| MS-16 | No feature gating on push, location or ATT                                                                                                                         | Apple 5.1.2(i), 5.1.1(iv)                                                          | LSP                                                   | confirmed                   | Every permission step has a fallback (table §10)                                                                                                      | QA scripts                                                  | Deny-all journey completes                                                           |
| MS-17 | In-app account deletion (with legally required retention disclosed)                                                                                                | Apple 5.1.1(v); Play account-deletion policy (likely)                              | LSP + RE                                              | confirmed / likely          | "Delete account" flow that closes the account and purges data not under legal hold                                                                    | Deletion tickets                                            | Deletion within SLA; retained fields documented                                      |
| MS-18 | OTA code must not change primary purpose or bypass security; no hidden features                                                                                    | Apple DPLA 3.3.1(B); Guidelines 2.3.1, 2.5.2; Play Device & Network Abuse (likely) | LSP                                                   | confirmed / likely          | EAS Update code signing; fingerprint runtime; change-class policy (no regulated logic via OTA); compliance sign-off                                   | Update manifests, approvals, `updateId` in audit logs       | Unsigned update is rejected by the client                                            |
| MS-19 | Device integrity checks on high-risk actions                                                                                                                       | Play Integrity docs (best practice); RBI fraud expectations (interpretation)       | LSP                                                   | recommendation              | `@expo/app-integrity`; server verifies; `requestHash` bound to action                                                                                 | Verdict logs                                                | Tampered build gets denied or step-up                                                |
| MS-20 | Accessible UI (WCAG 2.2 AA) and vernacular KFS                                                                                                                     | WCAG 2.2; RBI KFS (likely)                                                         | LSP + RE                                              | likely                      | Accessibility checklist in definition-of-done; i18n with legal-reviewed translations                                                                  | Audit reports                                               | TalkBack/VoiceOver journey test in Hindi                                             |

---

## Challenges to the owner's plan

1. **"Ask phone permissions for OTP reading."** READ_SMS and RECEIVE_SMS are restricted by Play to default SMS handlers, and RBI bars DLAs from telephony and SMS-type resources. **Alternative:** SMS Retriever for Udofin OTPs, SMS User Consent for UIDAI and eSign OTPs, `oneTimeCode` on iOS, and manual entry. _Authority:_ Play SMS/Call Log policy; Android "Minimize permission requests"; RBI DL.
2. **"Location" permission.** ACCESS_FINE_LOCATION is prohibited for loan apps on Play, and `expo-location` adds it by default. **Alternative:** coarse location, one time, only where an RE's KYC or credit policy needs it, with a manual or Aadhaar-address fallback. Block FINE and BACKGROUND. _Authority:_ Play Financial Services; RBI DL one-time access; Apple 5.1.1(iv).
3. **"Camera scanning of KYC docs."** Prefer DigiLocker and CKYC: no images, higher assurance. Where paper is unavoidable, use the ML Kit Document Scanner (no Android camera permission) or VisionKit. Never use gallery-wide access. **Alternative:** the photo picker and document picker, with READ_MEDIA_* and storage permissions blocked.
4. **PAYDAY loans.** These cannot be listed on Google Play (≤60-day full repayment) or the App Store (≤60 days and 36% APR cap). Including them risks removal of the **entire** app, the main DLA channel for all REs. **Alternative:** drop payday, or redesign as ≥61-day amortising small-ticket loans with transparent APR. Suppress iOS offers above 36% APR. Do not route iOS users to web payday offers.
5. **Personal "books of accounts" from the phone.** SMS parsing or storage access is barred (Play and RBI). **Alternative:** RBI Account Aggregator consent flows plus manual entries, with explicit purpose limitation.
6. **Collections run by Udofin (FLDG rationale).** The app must never access contacts, call logs, photos or location for recovery. Play bans the permissions and Apple 5.1.2(iv)–(v) bars contact databases. **Alternative:** in-app reminders and self-service repayment only. Collections conduct is covered in the RBI and collections report.
7. **Marketing push notifications.** These need a separate explicit opt-in and an in-app opt-out (Apple 4.5.4) and must carry no sensitive loan data. **Alternative:** split the consents into transactional and marketing, with neutral push copy.
8. **AI agent answering borrower queries.** Apple 5.1.2(i) requires disclosure and explicit permission before sharing personal data with third-party AI, and the Data safety form must reflect it. **Alternative:** opt-in, redaction, a named vendor and a human-escalation path.
9. **Multi-lender marketplace and directory listing.** Udofin cannot self-list. Each RE must report the app (and the web DLA) to RBI before Play onboarding, and the listing must name the REs. **Alternative:** add "RBI DLA reporting confirmed" as a contractual condition precedent in every RE agreement, and gate releases on it (MS-01).
10. **Escalation to group-owned Equator "without a separate app."** Linking out is fine technically. Sharing data with a related entity must be disclosed (Apple 5.1.1(i) covers _"parent, subsidiary or other related entities"_) and consented to. **Alternative:** make Equator escalation a borrower-initiated choice with a clear disclosure. Whether ADR can be compelled is for the legal and RBI reports.
11. **Over-the-air updates as a fast path.** OTA changes to KFS, APR, consent or new products would conflict with Apple 2.3.1 and DPLA 3.3.1(B), and with audit needs. **Alternative:** a signed-update change policy, server-versioned legal text, and native releases for any regulated change.
12. **Off-the-shelf KYC and eSign SDK defaults.** Vendor READMEs (e.g. Digio) instruct adding banned permissions. **Alternative:** `blockedPermissions`, vendor confirmation of a "lending-safe" mode, and a merged-manifest CI gate.

## Open questions

1. What exact documents does Play Console accept today from an **LSP** (non-licensee) in the Personal Loan App Declaration, and must _each_ RE's directory entry list the same package name? This needs a re-read of the live Play page plus a Play support ticket.
2. Does each partner RE agree to report the Udofin **web** borrower portal as a separate DLA, and how fast can additions and removals happen as REs join or leave?
3. How should "APR including costs and fees" (Apple) be reconciled with RBI's KFS APR? Does Apple treat secured products (home, LAP, LAS) as "personal loans"? Should the cap be applied app-wide to be conservative?
4. Will any RE require a selfie, liveness check or V-CIP inside Udofin's app (and so CAMERA, RECORD_AUDIO, coarse location), or will it run KYC in its own channel?
5. Is the payday product dropped, restructured (≥61 days), or confined to an RE's own channel? This is a business and legal decision.
6. How should the Play Integrity enforcement threshold be set given India's older or uncertified device base? This is a financial-inclusion versus fraud trade-off.
7. Which data must be kept despite a deletion request (PMLA, RBI record-keeping, CIC reporting), and how is that disclosed in the Data safety form and privacy policy?
8. Do Google Play's "Financial features" declaration and the developer-verification programme impose further steps for this account? These could not be verified this session.
9. Is the Supreme Court's 2025 accessible-KYC direction now in RBI's KYC Master Direction, and what alternative-liveness options must be offered?

## Self-verification

| #   | Claim                                                                                                     | Check performed                                                                                                                                   | Verdict                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | Apple 3.2.2(ix): 36% APR cap incl. fees; no full repayment ≤60 days                                       | Fetched developer.apple.com guidelines (Last Updated 8 Jun 2026)                                                                                  | **confirmed** (verbatim)                                                                |
| 2   | Play: new India personal-loan apps must be on RBI DLA list from 30 Oct 2025; existing apps by 28 Jan 2026 | Two independent search extracts of Google's page 16604194; live page not fetchable                                                                | **confirmed via extract**; could not full-page verify                                   |
| 3   | Play prohibited-permission list (6 original + QUERY_ALL_PACKAGES, WRITE_EXTERNAL_STORAGE)                 | 2023 list in multiple reports and the Digio README; additions only in Google-page extracts                                                        | **6 confirmed; 2 additions could-not-verify (kept as likely)**                          |
| 4   | Play's 60-day rule applies globally, 36% APR cap US-only                                                  | Search extracts of page 9876821                                                                                                                   | **confirmed via extract**                                                               |
| 5   | Target API 36 for new apps and updates from 31 Aug 2026; extension to 1 Nov 2026; existing apps API 35    | Fetched developer.android.com (updated 2026-10-01)                                                                                                | **confirmed**                                                                           |
| 6   | Expo 57.0.27 bundles RN 0.86.3; New Architecture mandatory                                                | npm tarball `bundledNativeModules.json`; RN 0.86.3 source (`new_arch_enabled` returns true)                                                       | **confirmed**; note the brief's "0.86" is right for Expo, while npm latest RN is 0.87.1 |
| 7   | Expo default template and modules add banned permissions; `blockedPermissions` uses `tools:node="remove"` | Read manifests in `expo-template-bare-minimum` 57.0.29, `expo-image-picker`, `expo-location`, `expo-camera` plugin; `@expo/config-plugins` source | **confirmed**                                                                           |
| 8   | ML Kit doc scanner needs no Android CAMERA permission                                                     | Plugin README plus empty manifest plus gradle dependency; Google ML Kit page not fetchable                                                        | **confirmed (library level)**                                                           |
| 9   | Photo picker needs no runtime permission                                                                  | developer.android.com "Minimize permission requests"                                                                                              | **confirmed**                                                                           |
| 10  | Apple DPLA 3.3.1(B) interpreted-code conditions                                                           | Fetched DPLA text                                                                                                                                 | **confirmed** (verbatim)                                                                |
| 11  | Xcode 26 / iOS 26 SDK required since 28 Apr 2026                                                          | Fetched Apple Upcoming Requirements                                                                                                               | **confirmed**                                                                           |
| 12  | `@expo/app-integrity` wraps App Attest and Play Integrity                                                 | Package type definitions in 57.0.2                                                                                                                | **confirmed**                                                                           |
| 13  | RBI DLA directory operational from 01.07.2025; Digital Lending Directions 2025 dated 8 May 2025           | PIB and Google-page extracts; rbi.org.in not fetchable                                                                                            | **confirmed via secondary/extract**; para numbers deliberately not given                |
| 14  | Play SMS/Call Log change on 27 Jan 2027                                                                   | Fetched developer.android.com play-policies timeline                                                                                              | **confirmed**                                                                           |

Corrections made during drafting:

- Android's constant is `READ_MEDIA_VIDEO`, not "VIDEOS".
- The 36% APR cap on Play is US-only; it is global only on Apple.
- `@expo/app-integrity` is not part of Expo's bundled module set, so pin it explicitly.

## Sources

**Primary**

- [Financial Services – Play Console Help](https://support.google.com/googleplay/android-developer/answer/9876821). Google; accessed via search extracts 2026-10-10.
- [Personal loans in India – Play Console Help](https://support.google.com/googleplay/android-developer/answer/16604194). Google; accessed via search extracts 2026-10-10.
- [Use of SMS or Call Log permission groups](https://support.google.com/googleplay/android-developer/answer/10208820). Google; link confirmed via developer.android.com; not fetched.
- [Permissions and APIs that access sensitive information](https://support.google.com/googleplay/android-developer/answer/9047303). Google; link confirmed via developer.android.com; not fetched.
- [Play policies timeline](https://developer.android.com/distribute/play-policies). Google; accessed 2026-10-10.
- [Target API level requirements](https://developer.android.com/google/play/requirements/target-sdk). Google; updated 2026-10-01.
- [Minimize your permission requests](https://developer.android.com/privacy-and-security/minimize-permission-requests). Google; accessed 2026-10-10.
- [Default handlers (SMS/Call Log)](https://developer.android.com/guide/topics/permissions/default-handlers). Google; accessed 2026-10-10.
- [Photo picker](https://developer.android.com/training/data-storage/shared/photo-picker). Google; accessed 2026-10-10.
- [SMS Retriever API](https://developer.android.com/identity/sms-retriever). Google; accessed 2026-10-10.
- [Phone number verification with Digital Credentials](https://developer.android.com/identity/digital-credentials/phone-number-verification). Google; accessed 2026-10-10.
- [Play Integrity overview](https://developer.android.com/google/play/integrity/overview). Google; updated 2026-04-20.
- [Play Integrity setup](https://developer.android.com/google/play/integrity/setup). Google; accessed 2026-10-10.
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/). Apple; last updated 2026-06-08.
- [Apple Developer Program License Agreement §3.3.1(B)](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/). Apple; accessed 2026-10-10.
- [Upcoming requirements](https://developer.apple.com/news/upcoming-requirements/). Apple; accessed 2026-10-10.
- [Third-party SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/). Apple; accessed 2026-10-10.
- [User Privacy and Data Use (ATT)](https://developer.apple.com/app-store/user-privacy-and-data-use/). Apple; accessed 2026-10-10.
- npm package sources, downloaded 2026-10-10:
  - [expo 57.0.27](https://www.npmjs.com/package/expo) (2026-10-06)
  - [react-native 0.86.3](https://www.npmjs.com/package/react-native)
  - [@expo/config-types](https://www.npmjs.com/package/@expo/config-types)
  - [@expo/config-plugins 57.0.10](https://www.npmjs.com/package/@expo/config-plugins)
  - [expo-template-bare-minimum 57.0.29](https://www.npmjs.com/package/expo-template-bare-minimum)
  - [expo-image-picker 57.0.20](https://www.npmjs.com/package/expo-image-picker)
  - [expo-location](https://www.npmjs.com/package/expo-location)
  - [expo-camera 57.0.6](https://www.npmjs.com/package/expo-camera)
  - [expo-notifications 57.0.22](https://www.npmjs.com/package/expo-notifications)
  - [expo-updates 57.0.25](https://www.npmjs.com/package/expo-updates)
  - [expo-secure-store 57.0.4](https://www.npmjs.com/package/expo-secure-store)
  - [@expo/app-integrity 57.0.2](https://www.npmjs.com/package/@expo/app-integrity)

**Secondary**

- npm package sources, downloaded 2026-10-10:
  - [react-native-document-scanner-plugin 2.0.4](https://www.npmjs.com/package/react-native-document-scanner-plugin) (2026-01-02)
  - [@pushpendersingh/react-native-otp-verify 1.2.0](https://www.npmjs.com/package/@pushpendersingh/react-native-otp-verify)
  - [jail-monkey 3.0.0](https://www.npmjs.com/package/jail-monkey)
  - [freerasp-react-native 5.2.3](https://www.npmjs.com/package/freerasp-react-native)
  - [react-native-ssl-public-key-pinning 1.2.6](https://www.npmjs.com/package/react-native-ssl-public-key-pinning)
  - [@digiotech/react-native 2.0.15](https://www.npmjs.com/package/@digiotech/react-native)
  - [react-native-hyperkyc-sdk 2.7.0](https://www.npmjs.com/package/react-native-hyperkyc-sdk)
- [PIB – Government and RBI strengthen measures against fraudulent loan apps](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2241255). Government press release; search extract only.
- [TechCrunch – Google to prohibit personal loan apps from accessing user photos, contacts](https://techcrunch.com/2023/04/05/google-personal-loan-apps-update/). 2023-04-05.
- [Business Today – Google to restrict personal loan apps from Play Store starting today](https://www.businesstoday.in/tech-today/trending/story/google-to-restrict-personal-loan-apps-from-play-store-starting-today-383608-2023-05-31). 2023-05-31.
- [myappmonitor – Google Play Personal Loans Policy Update (Aug 2025)](https://myappmonitor.com/blog/google-play-personal-loans-policy-update). 2025; unverified.
- [Credolab – Guide to Google Play Personal Loans Policy changes (PDF)](https://cdn.prod.website-files.com/63036d38271cd821b954a407/68ec7962800abd3787068c8c_Credolab%20-%20Guide%20to%20Google%20Play%20Personal%20Loans%20Policy%20changes.pdf). 2025; vendor interpretation, not fetched.
- [gocredit.money – RBI registered loan apps list](https://gocredit.money/loan-app/list). 2026; directory count unverified.
