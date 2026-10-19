# Research notes — 10 October 2026

These notes informed the baseline architecture. They were produced by research agents and are kept
for traceability. **They are not legal advice and are not verified against primary texts.**

## Limitations (read before relying on anything here)

- The research sandbox could not open primary sources: web page fetches failed (DNS) and the
  network proxy blocked rbi.org.in, uidai.gov.in, npci.org.in, provider sites and Google's policy
  pages. A shared limit of 200 web searches per session was also exhausted part-way through.
- Findings therefore rest on search-result snippets of official pages plus secondary sources (law
  firms, regulatory-technology vendors, news). Each claim carries a label: **confirmed** (several
  independent sources or an official-page snippet), **likely**, **interpretation** or **unverified**.
- Paragraph numbers in the November 2025 consolidated RBI directions are mostly unverified.
- The owner's request to review RBI master directions "uploaded here" could not be met: no
  documents were attached. Please add the PDFs (for example under `docs/regulatory/sources/`) or
  enable network access to rbi.org.in so they can be checked line by line.

## Notes

| File                                                                 | Topic                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`rbi-digital-lending.md`](rbi-digital-lending.md)                   | RBI digital lending framework after the 28 Nov 2025 consolidation; 2026 changes; DLG |
| [`kyc-aadhaar-bureau.md`](kyc-aadhaar-bureau.md)                     | KYC/AML, Aadhaar, DigiLocker, CKYC, PAN, credit bureaus; who may use each rail       |
| [`privacy-security-outsourcing.md`](privacy-security-outsourcing.md) | DPDP, outsourcing, IT/cyber, CERT-In, e-signing, stamping, retention, AI             |
| [`grievance-adr-collections.md`](grievance-adr-collections.md)       | RB-IOS 2026, grievance obligations, mediation/arbitration, recovery conduct          |
| [`competitors-ux.md`](competitors-ux.md)                             | Indian lending apps and marketplaces; UX patterns; MVP scope                         |
| [`providers-payments.md`](providers-payments.md)                     | Surepass and other providers; payment, mandate and disbursement rails                |
| [`app-store-mobile.md`](app-store-mobile.md)                         | Google Play and App Store loan-app policies; Expo/React Native constraints           |
| [`infra-stack.md`](infra-stack.md)                                   | Hosting regions, Supabase, AWS, queues, frameworks, observability                    |
| [`ecosystem-sites.md`](ecosystem-sites.md)                           | Public footprint of Udofin, Finbyx, LawDocsComply, Equator                           |
