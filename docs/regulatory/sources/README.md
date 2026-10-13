# Primary regulatory sources on file

Official RBI texts supplied by the product owner on 13 October 2026. They are the **only** regulatory
sources in this repository that were read directly from the primary text; everything else in
`docs/research/` rests on search snippets and secondary commentary and keeps its
confirmed / likely / interpretation / unverified label.

| File                                                                                    | Instrument                                                                                  | Reference           | Date                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------- | ------------------------------- |
| `rbi-nbfc-credit-facilities-directions-2025-updated-2026-04-01.pdf`                     | NBFC – Credit Facilities Directions, 2025 (Chapter III: Digital Lending incl. DLG)          | RBI/DOR/2025-26/347 | 28 Nov 2025, updated 1 Apr 2026 |
| `rbi-nbfc-managing-risks-in-outsourcing-directions-2025.pdf`                            | NBFC – Managing Risks in Outsourcing Directions, 2025                                       | RBI/DOR/2025-26/363 | 28 Nov 2025                     |
| `rbi-nbfc-cybersecurity-technology-risk-resilience-assurance-directions-2026-07-31.pdf` | NBFC – Cybersecurity, Technology: Risk, Resilience and Assurance Framework Directions, 2026 | RBI/DoS/2026-27/461 | 31 Jul 2026                     |
| `rbi-nbfc-credit-information-reporting-directions-2025.pdf`                             | NBFC – Credit Information Reporting Directions, 2025                                        | RBI/DOR/2025-26/349 | 28 Nov 2025                     |
| `rbi-nbfc-credit-risk-management-directions-2025-updated-2026-04-01.pdf`                | NBFC – Credit Risk Management Directions, 2025                                              | RBI/DOR/2025-26/350 | 28 Nov 2025, updated 1 Apr 2026 |

`SHA256SUMS` holds the checksum of each file as received (`sha256sum -c SHA256SUMS`). Do not edit
these files. When RBI issues a new version, add it beside the old one under a new name and record
which version each paragraph reference in `../primary/` was checked against.

Extracts and the design consequences for Udofin are in [`../primary/`](../primary/README.md).
These PDFs are public documents from rbi.org.in; they contain no personal data.

## Still needed

See section 7 of `../primary/01-credit-facilities-chapter-III-digital-lending.md`: the Responsible
Business Conduct Directions 2025 (recovery-agent conduct, KFS, penal charges) and amendments, the
Income Recognition and Asset Classification Directions 2025, the 6 August 2026 recovery-agent
amendment, the Integrated Ombudsman Scheme 2026, the KYC Directions, and the Capital Adequacy
Directions 2025.
