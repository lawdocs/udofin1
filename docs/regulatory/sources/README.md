# Primary regulatory sources on file

Official RBI texts supplied by the product owner on 13 October 2026. They are the **only** regulatory
sources in this repository that were read directly from the primary text; everything else in
`docs/research/` rests on search snippets and secondary commentary and keeps its
confirmed / likely / interpretation / unverified label.

| File                                                                                                   | Instrument                                                                                  | Reference           | Date                             |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------- | -------------------------------- |
| `rbi-nbfc-credit-facilities-directions-2025-updated-2026-04-01.pdf`                                    | NBFC – Credit Facilities Directions, 2025 (Chapter III: Digital Lending incl. DLG)          | RBI/DOR/2025-26/347 | 28 Nov 2025, updated 1 Apr 2026  |
| `rbi-nbfc-managing-risks-in-outsourcing-directions-2025.pdf`                                           | NBFC – Managing Risks in Outsourcing Directions, 2025                                       | RBI/DOR/2025-26/363 | 28 Nov 2025                      |
| `rbi-nbfc-cybersecurity-technology-risk-resilience-assurance-directions-2026-07-31.pdf`                | NBFC – Cybersecurity, Technology: Risk, Resilience and Assurance Framework Directions, 2026 | RBI/DoS/2026-27/461 | 31 Jul 2026                      |
| `rbi-nbfc-credit-information-reporting-directions-2025.pdf`                                            | NBFC – Credit Information Reporting Directions, 2025                                        | RBI/DOR/2025-26/349 | 28 Nov 2025                      |
| `rbi-nbfc-credit-risk-management-directions-2025-updated-2026-04-01.pdf`                               | NBFC – Credit Risk Management Directions, 2025                                              | RBI/DOR/2025-26/350 | 28 Nov 2025, updated 1 Apr 2026  |
| `rbi-nbfc-responsible-business-conduct-directions-2025-updated-2026-04-01.pdf`                         | NBFC – Responsible Business Conduct Directions, 2025 (KFS, penal charges, recovery agents)  | RBI/DOR/2025-26/362 | 28 Nov 2025, updated 1 Apr 2026  |
| `rbi-nbfc-income-recognition-asset-classification-provisioning-directions-2025-updated-2026-02-13.pdf` | NBFC – Income Recognition, Asset Classification and Provisioning Directions, 2025           | RBI/DOR/2025-26/356 | 28 Nov 2025, updated 13 Feb 2026 |
| `rbi-nbfc-kyc-directions-2025-updated-2025-12-29.pdf`                                                  | NBFC – Know Your Customer Directions, 2025                                                  | RBI/DOR/2025-26/361 | 28 Nov 2025, updated 29 Dec 2025 |
| `rbi-nbfc-capital-adequacy-directions-2025-updated-2026-04-01.pdf`                                     | NBFC – Prudential Norms on Capital Adequacy Directions, 2025                                | RBI/DOR/2025-26/345 | 28 Nov 2025, updated 1 Apr 2026  |
| `rbi-integrated-ombudsman-scheme-2026.pdf`                                                             | Reserve Bank – Integrated Ombudsman Scheme, 2026 (in force 1 Jul 2026)                      | —                   | 2026                             |

`SHA256SUMS` holds the checksum of each file as received (`sha256sum -c SHA256SUMS`). Do not edit
these files. When RBI issues a new version, add it beside the old one under a new name and record
which version each paragraph reference in `../primary/` was checked against.

Extracts and the design consequences for Udofin are in [`../primary/`](../primary/README.md).
These PDFs are public documents from rbi.org.in; they contain no personal data.

## Still needed

Received on 13 October 2026 and no longer outstanding: Responsible Business Conduct, IRAC, KYC, Capital Adequacy and the Integrated Ombudsman Scheme. Still needed from the owner or compliance owner:

- Amendments issued **after** the dates above, in particular the RBC Second Amendment (15 Jun 2026) and the recovery-agent amendment of 6 Aug 2026 (effective 1 Jan 2027).
- The credit-information reporting 1st amendment (weekly reporting) and circular DoS.CO.PPG.66/11.01.005/2026-27 (repeal of earlier IT directions).
- Resolution of Stressed Assets Directions and Part B of the Transfer and Distribution of Credit Risk Directions (cross-referenced from the IRAC text).
- The Scale Based Regulation directions (layer thresholds), and the Digital Lending-related FAQ or circulars, if any, issued after 1 Apr 2026.
