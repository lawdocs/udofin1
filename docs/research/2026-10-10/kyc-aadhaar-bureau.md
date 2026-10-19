# KYC/AML, Aadhaar, DigiLocker, CKYC, PAN and credit-bureau access for Udofin (an LSP/DLA working with NBFC lenders), as of 10 Oct 2026

## 0. How this was researched, and its limits

- **No primary documents could be fetched.** WebFetch failed with DNS errors for every host tried, including rbi.org.in, rbidocs.rbi.org.in, website.rbi.org.in, uidai.gov.in, vinodkothari.com, taxguru.in and surepass.io. Direct HTTPS through the sandbox proxy was also refused (403 CONNECT) for rbi.org.in and every other host tested.
- **Everything below comes from search snippets.** I ran about 33 web searches before the session's search budget ran out. The snippets are mostly from secondary sources, plus excerpts of primary PDFs that the search engine indexed.
- **Paragraph numbers are not given unless a source quoted them.** None were invented. Where only a secondary source supports a point, it is marked _likely_ or _unverified_.
- **Before relying on any of this,** have counsel check the operative text of the following RBI instruments: the NBFC KYC Directions 2025, the NBFC Credit Facilities Directions 2025 (Chapter III, digital lending), the CIC Directions 2025 and the Credit Information Reporting Directions.

## 1. Bottom line

1. **The lender (RE) is the legal "user" of every KYC and bureau rail. Udofin is not.**
   - Under PMLA and the RBI KYC Directions, customer due diligence is the RE's obligation.
   - Online Aadhaar authentication is limited to banks and REs notified under PMLA s.11A, or REs using NPCI's e-KYC Setu.
   - CKYCR access is limited to registered reporting entities.
   - Protean's online PAN verification is limited to listed regulated categories.
   - Bureau data can go only to credit institutions and RBI-approved "specified users". A specified user may not pass it to anyone else (CICRA s.17(4)).
   - Udofin should run the **user interface and orchestration**, using **each RE's credentials, consents and storage**. It should keep only "basic minimal data", as the Digital Lending (DL) Directions require.
2. **Udofin cannot itself do a "CIBIL soft pull" and share the result with several lenders.**
   - A new LSP cannot realistically qualify as a specified user. Among other conditions, the criteria require at least 3 years of processing information for credit institutions.
   - Even a specified user may not pass a credit report to others.
   - Each lender must pull the bureau itself. India has no regulatory concept of a "soft pull". Whether an enquiry is "soft" depends on how the bureau classifies the enquiry type.
3. **Udofin cannot lawfully run "Aadhaar OTP fetch" through Surepass in its own name.**
   - Surepass's own Aadhaar Authentication page says businesses need an AUA/KUA licence, or sub-AUA/sub-KUA status.
   - Appointing a sub-AUA or sub-KUA needs prior UIDAI approval and a statutory basis. Udofin, as an LSP that is not a PMLA reporting entity, does not have one.
   - Since December 2025, Paperless Offline e-KYC (XML) and Aadhaar Verifiable Credential (AVC) verification require the verifier to register with UIDAI as an Offline Verification Seeking Entity (OVSE).
4. **Several 2025–2026 changes matter here:**
   - the 28 Nov 2025 consolidation;
   - the 29 Dec 2025 KYC amendment on relying on CKYCR records;
   - the June 2025 periodic-updation amendment;
   - the December 2025 Aadhaar offline-verification amendment (OVSE registration, offline face verification);
   - the move to weekly credit reporting with a CKYC-number field, from 1 Jul 2026;
   - the 31 Jul 2026 cybersecurity directions, which flow down to vendors.

## 2. Regulatory map (what exists as of 10 Oct 2026)

### 2.1 The 28 Nov 2025 consolidation

- **What happened.** RBI replaced the 2016 KYC Master Direction with ten entity-specific KYC Directions as part of its mass consolidation. Sources count either 238 or 244 Master Directions.
- **The NBFC instrument** is the _Reserve Bank of India (Non-Banking Financial Companies – Know Your Customer) Directions, 2025_, ref. RBI/DOR/2025-26/361. Secondary sources say it was "last updated as on December 29, 2025".
  - Primary PDF: [RBI/DOR/2025-26/361 PDF](https://rbidocs.rbi.org.in/rdocs/notification/PDFs/361MD1E2F8EA063454AD5AFA1D02A1BA5ACA7.PDF) (28 Nov 2025; could not be fetched).
  - Secondary: [Signzy summary](https://www.signzy.com/blogs/RBI-KYC-Master-Directions-2025-key-changes), [HyperVerge NBFC KYC guide](https://hyperverge.co/blog/kyc-for-nbfcs/), [Vinod Kothari, Year in Review 2025](https://vinodkothari.com/wp-content/uploads/2026/01/RBI-Regulatory-Developments-2025-1.pdf) (Jan 2026).
- **Other instruments from the same date that bear on this topic:**
  - _RBI (NBFC – Credit Facilities) Directions, 2025._ Chapter III covers digital lending, LSP arrangements, technology/data and DLG, and DLG is capped at 5%. RBI's Master Direction page lists updated versions dated 1 Apr 2026 and 15 Jul 2026. [TaxGuru](https://taxguru.in/rbi/rbi-non-banking-financial-companies-credit-facilities-directions-2025.html); [RBI MD page](https://rbi.org.in/SCRIPTs/BS_ViewMasDirections.aspx?id=12957).
  - _RBI (Credit Information Companies) Directions, 2025._ [TaxGuru](https://taxguru.in/rbi/rbi-credit-information-companies-directions-2025.html).
  - _RBI (NBFC – Credit Information Reporting) Directions, 2025._ [TaxGuru](https://taxguru.in/rbi/rbi-non-banking-financial-companies-credit-information-reporting-directions-2025.html).
- **The standalone DL Directions.** The _RBI (Digital Lending) Directions, 2025_ of 8 May 2025 hold the operative LSP rules. Secondary sources say they are folded into Chapter III of the NBFC Credit Facilities Directions. [Text mirror](https://littdb.sfo2.cdn.digitaloceanspaces.com/litt/IN/RBI/notifications/RBI_12848.html); [Lexplosion](https://lexplosion.in/rbi-issues-consolidated-guidelines-on-digital-lending-effective-immediately/).
  - Paragraph 6 (multi-lender arrangements) applied from 1 Nov 2025.

### 2.2 KYC amendments since then

- **12 Jun 2025 (KYC amendment plus circular RBI/2025-26/53):**
  - Low-risk individuals may complete periodic updation within one year of the due date or by **30 Jun 2026**, whichever is later.
  - Banks may use business correspondents (BCs) for updation.
  - REs must send three advance intimations and three post-due reminders (at least one of each by letter), fully implemented by **1 Jan 2026**.
  - Sources: [RBI notification page](https://website.rbi.org.in/web/rbi/-/notifications/updation/-periodic-updation-of-kyc-revised-instructions-1) (12 Jun 2025); [FIDC copy of circular](https://www.fidcindia.org.in/wp-content/uploads/2025/06/RBI-UPATION-OF-KYC-12-06-25.pdf); [TaxGuru](https://taxguru.in/rbi/reserve-bank-india-know-customer-kyc-amendment-directions-2025.html).
- **29 Dec 2025 (KYC Amendment Directions; NBFC version inserts an Explanation under para 63):**
  - The RE that **last uploaded or updated** a customer's CKYCR record is responsible for verifying identity and address.
  - An RE that downloads and relies on a current, PMLA-compliant CKYCR record remains responsible for **all other CDD**.
  - The amendment is based on a Department of Revenue Office Memorandum of 18 Sep 2025.
  - Sources: [Lexplosion](https://lexplosion.in/rbi-amends-kyc-directions-clarifying-that-the-responsibility-of-verification-of-identity-address-will-lie-with-the-re-that-has-last-uploaded-updated-the-customers-kyc-records-in-ckycr/); [Mehta & Mehta (NBFC version)](https://mehta-mehtaadvisory.com/rbi-update-reserve-bank-of-india-non-banking-financial-companies-know-your-customer-amendment-directions-2025/); [vendor-hosted copy of RBI/2025-26/166](https://trackwizz.com/knowledge-hub/wp-content/uploads/2025/12/RBI-KYC-Amendment-Directions-2025-29.12.2025.pdf) (29 Dec 2025).
  - **Why it matters for Udofin:** this is the lawful "KYC once, reuse across lenders" mechanism. The reuse runs through CKYCR, not through Udofin's database.
- **2026:** no separate "KYC Amendment Directions 2026" for NBFCs turned up. The 2026 NBFC amendment that did turn up concerns Type I NBFC registration and exemptions (effective 1 Jul 2026). [Legal500](https://www.legal500.com/developments/thought-leadership/rbi-amendments-2026-a-new-category-for-nbfc-registration-and-exemptions/). Status: unverified that nothing else exists.

### 2.3 What was issued on 31 Jul 2026 (the owner's second date)

- **What was found.** On 31 Jul 2026, RBI's Department of Supervision issued six or seven entity-specific **cybersecurity / technology-risk directions**. They include:
  - NBFCs: reported as RBI/DoS/2026-27/461;
  - Credit Information Companies: reported as RBI/DoS/2026-27/470;
  - Commercial banks: RBI/DoS/2026-27/410.
- **Key features reported:** incident reporting to the DAKSH platform within 6 hours, repeal of the earlier IT/cyber frameworks, and flow-down of obligations to vendors.
- Sources: [TaxGuru on NBFC directions](https://taxguru.in/rbi/rbi-issues-nbfc-cybersecurity-technology-risk-directions-2026-governance-framework.html); [Bitscore overview](https://www.bitscore.in/resources/rbi-cybersecurity-directions-2026); [copy of RBI/DoS/2026-27/410](https://www.lexsite.com/eDocs/RBI-DoS-410.pdf) (31 Jul 2026).
- **What was not found:** a KYC, digital-lending or credit-reporting Master Direction dated 31 Jul 2026. One aggregator listing mentions "CIC – Miscellaneous Supervisory Directions, 2026" on that date. Status: unverified.
- **Relevance:** Udofin will be a technology vendor holding the RE's KYC and bureau data flows, so the NBFC and CIC cyber directions will reach it through contract.

## 3. Who is the legal "user" of each rail

| Rail                                                    | Legal gate                                                                         | Eligible party                                                                  | Udofin's lawful role                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Aadhaar OTP/biometric e-KYC (online authentication)     | Aadhaar Act s.4(4); PMLA s.11A; UIDAI AUA/KUA/sub-KUA approval                     | Banks; REs notified under s.11A; REs using NPCI e-KYC Setu                      | UI host only. RE's KUA/Setu credentials; data to RE           |
| Aadhaar offline verification (XML, AVC via Aadhaar app) | Aadhaar Act s.8A; 2021 Regs as amended Dec 2025 (Reg 13A OVSE registration)        | Any OVSE that is **registered** (QR/e-Aadhaar exempt from registration)         | UI host only. RE should be the registered OVSE                |
| DigiLocker issued documents                             | DigiLocker Requester onboarding (API Setu); KYC Directions "equivalent e-document" | Registered Requester (government or private)                                    | Preferably RE's requester credentials, or the RE's KYC vendor |
| CKYCR search/download/upload                            | PML Rules r.9; CERSAI operating guidelines                                         | Reporting entities registered with CERSAI                                       | None directly. Show the KYC identifier the RE returns         |
| PAN online verification                                 | ITD authorisation of Protean OPV                                                   | Banks, RBI-registered NBFCs, HFCs, PPI issuers, SEBI/IRDAI/PFRDA entities, etc. | None directly. RE's OPV or RE-contracted vendor               |
| Credit report/score                                     | CICRA ss.2, 17(4); CIC Regulations 2006 reg 9; CIC Directions 2025                 | Credit institutions (members) and approved specified users                      | Trigger the RE's pull. Do not receive or store the report     |

## 4. RBI KYC Directions for NBFCs: what the RE must do, and what Udofin may do

**Modes of CDD for a non-face-to-face digital lender (RE's obligation).**

_Digital KYC_

- An authorised RE official captures a live photo of the customer and of the OVD (or proof of possession of Aadhaar, where offline verification cannot be done), with latitude and longitude.
- Source: definition in the 2025 Directions, per indexed excerpts of [RBI/DOR/2025-26/361](https://rbidocs.rbi.org.in/rdocs/notification/PDFs/361MD1E2F8EA063454AD5AFA1D02A1BA5ACA7.PDF). Status: likely.

_V-CIP (video KYC)_

- V-CIP is treated as equivalent to face-to-face onboarding.
- It must be carried out by a **trained official of the RE**, with:
  - liveness and spoof detection plus face match;
  - detection of IP addresses outside India or spoofed;
  - geo-tagged, time-stamped recordings;
  - an audit trail.
- From the inherited 2016 framework (likely carried forward): the RE must own the V-CIP infrastructure, and recordings must go to RE-owned or leased storage, with no retention by the technology provider.
- Sources: [HyperVerge V-CIP](https://hyperverge.co/blog/rbi-video-kyc-guidelines/); [IDfy](https://www.idfy.com/blog/rbis-direction-on-v-cip-video-kyc/). Status: likely; RE-premises and no-vendor-retention: unverified in the 2025 text.

_Aadhaar OTP-based e-KYC (non-face-to-face)_

- Needs the customer's specific consent.
- Limits carried forward from the 2016 MD into the entity-specific 2025 Directions (per secondary sources):
  - aggregate term loans of no more than **₹60,000 a year**;
  - full CDD within one year;
  - the account flagged as OTP-based in CKYCR.
- Available only to REs entitled to do Aadhaar authentication (see §5).
- Sources: [HyperVerge eKYC](https://hyperverge.co/blog/what-is-ekyc/); [Signzy](https://www.signzy.com/blogs/RBI-KYC-Master-Directions-2025-key-changes). Status: likely.

_Offline verification / proof of possession of Aadhaar_

- Open to all RBI-regulated REs. The RE does not need the Aadhaar number for it.
- Where a copy is kept, the first 8 digits must be redacted.
- Source: [Vinod Kothari, "Online Authentication of Aadhaar: Exclusive Club"](https://vinodkothari.com/2025/05/online-authentication-of-aadhaar-exclusive-club-members-only/) (May 2025). Status: likely.

_DigiLocker documents_

- Accepted as an "equivalent e-document" (documents issued to the customer's DigiLocker under Rule 9 of the 2016 Digital Locker Rules).
- The RE must **verify the digital signature** under the IT Act and **take a live photo**, as for digital KYC.
- Source: [RBI amendment to KYC MD (notification 11783)](https://website.rbi.org.in/web/rbi/-/notifications/amendment-to-master-direction-md-on-kyc-11783) (2020). Carried into 2025: likely.

_Aadhaar is not mandatory_

- Aadhaar is mandatory only for Aadhaar Act s.7 benefits, so alternative OVDs must be offered. [Signzy](https://www.signzy.com/blogs/RBI-KYC-Master-Directions-2025-key-changes). Status: likely.

**Outsourcing boundary.**

- RBI's outsourcing principles for NBFCs prohibit outsourcing decision-making functions such as _determining compliance with KYC norms_ and _sanctioning loans_. This comes from the inherited outsourcing directions, presumed carried into the 2025 consolidation; status likely.
- **Udofin may:** capture data and documents, host the UI and SDKs, and route consent screens.
- **Udofin may not:** decide that KYC is complete or reuse one lender's KYC for another lender.

## 5. Aadhaar: can Udofin "fetch Aadhaar via OTP" through Surepass?

**Statutory structure (confirmed in outline).**

- **Aadhaar Act s.4(4):** a requesting entity may do authentication only if it meets UIDAI's privacy and security standards **and** either (i) is permitted under a law of Parliament or (ii) has a purpose prescribed by the Central Government in the interest of the State.
- **s.8:** authentication requires consent and use only for the stated purpose.
- **s.8A:** offline verification requires consent.
- **s.29:** restricts sharing and use of identity information.
- Sources: [Aadhaar Act as amended](https://uidai.gov.in/images/Aadhaar_Act_2016_as_amended.pdf); [s.8A on India Code](https://www.indiacode.nic.in/show-data?actid=AC_CEN_37_85_00001_201618_1517807328460&sectionId=49433&sectionno=8A&orderno=10).

**PMLA s.11A is the route for KYC.**

- Banks may authenticate.
- Other reporting entities need a Central Government (Department of Revenue) notification, issued after UIDAI is satisfied and the regulator is consulted. [Vinod Kothari, May 2025](https://vinodkothari.com/2025/05/online-authentication-of-aadhaar-exclusive-club-members-only/).
- **Notifications found:**
  - S.O. 2012(E), 5 May 2025: five NBFCs (Oxyzo, Berar Finance, Finkurve, Tata Capital, BOBCARD). [CAclubindia](https://www.caclubindia.com/news/finance-ministry-notifies-five-nbfcs-for-aadhaar-based-authentication-under-pmla-24820.asp).
  - S.O. 2597(E), 21 May 2026: reportedly seven entities, including Toyota Financial Services, Aditya Birla Capital and LIC HFL. Status: unverified.
- **RBI channel:** since Sep 2021, NBFCs can apply through RBI for onward submission of a KUA/sub-KUA application to UIDAI. [RBI notification](https://rbidocs.rbi.org.in/rdocs/notification/PDFs/EKYCCD5A7A5B2F70471883B6E45D84E35855.PDF); [Vinod Kothari 2021](https://vinodkothari.com/2021/09/nbfcs-licensed-for-kyc-authentication/).
- **An LSP is not a PMLA reporting entity, so it cannot be notified under s.11A.** (Interpretation: PMLA "reporting entity" covers financial institutions such as NBFCs, not their service providers.)

**NPCI e-KYC Setu.**

- NPCI's brochure says REs need **no separate s.11A gazette notification** to use Setu for Aadhaar e-KYC.
- The RE receives the e-KYC data without collecting the Aadhaar number.
- SEBI allowed intermediaries to use it in June 2025.
- Sources: [NPCI brochure](https://www.npci.org.in/PDF/e-kyc-setu-system/Product-Brochure.pdf); [Vinod Kothari, Aug 2025](https://vinodkothari.com/2025/08/setu-ing-the-standard-npcis-new-path-to-aadhaar-e-kyc/); [TaxGuru on SEBI](https://taxguru.in/sebi/sebi-npci-e-kyc-setu-aadhaar-kyc.html).
- Setu is a **route for REs**, not for LSPs. Status: likely (confirm RBI-RE onboarding terms with NPCI).

**Sub-AUA/sub-KUA model.**

- Under Reg 14(1)(ga) of the 2021 Regulations, an AUA/KUA must get **prior UIDAI approval** before appointing a sub-AUA/sub-KUA.
- UIDAI **Circular 02 of 2025 (7 Feb 2025)** issued a revised application form and a joint undertaking.
- UIDAI also requires an annual undertaking that sub-entities were audited.
- A secondary source says the eligible categories include s.11A-notified entities. Status: unverified.
- Sources: [UIDAI Circular 02/2025](https://uidai.gov.in/images/Circular_2_of_2025_Amended__Sub-AUA_and_Sub-KUA_application_form__Joint_Undertaking.pdf); [UIDAI undertaking letter](https://uidai.gov.in/images/Undertaking_letter_to_AUA_KUA.pdf).
- Surepass markets a route to sub-AUA/KUA status "in less than 30 days". That is a vendor claim. **It does not remove the s.4(4) eligibility requirement or the need for UIDAI's approval.** [Surepass Aadhaar Authentication API](https://surepass.io/aadhaar-authentication-api/); [Surepass sub-AUA blog](https://surepass.io/blog/how-to-become-a-uidai-sub-aua-step-by-step-guide/).

**Good Governance Rules amendment (31 Jan 2025, G.S.R. 88(E)).**

- The amendment lets private entities seek Aadhaar authentication for purposes such as ease of living and access to services.
- Process: proposal to the relevant ministry → UIDAI review → MeitY approval → notification. The portal is [swik.meity.gov.in](https://swik.meity.gov.in/rules), launched 27 Feb 2025 ([PIB](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2106755)).
- No published approval of a lending or LSP use case was found.
- **Interpretation:** KYC for loans is governed by PMLA. Seeking s.4(4)(b)(ii) approval so an LSP can do lending KYC would be novel, slow and uncertain. It is not a basis to rely on today.

**Offline verification after December 2025.**

- The _Aadhaar (Authentication and Offline Verification) Amendment Regulations, 2025_ were gazetted around 9 Dec 2025; UIDAI's page lists 12 Dec 2025. They:
  - add **Reg 13A**, requiring entities that do **Aadhaar Paperless Offline e-KYC (XML)** or **AVC/Aadhaar-app** verification to **register with UIDAI as OVSEs** (QR-code and e-Aadhaar checks are exempt from registration);
  - introduce **offline face verification**;
  - extend penalties to sub-AUAs, sub-KUAs and OVSEs.
- Sources: [Vinod Kothari, Dec 2025](https://vinodkothari.com/2025/12/a-new-way-to-verify-aadhaar-offline-introduction-of-face-matching/); [Legal500](https://www.legal500.com/intelligence/india/compliance/aadhaar-authentication-and-offline-verification-amendment-regulations-2025-strengthening-india's-digital-identity-framework); [UIDAI regulations page](https://uidai.gov.in/en/about-uidai/legal-framework/regulations.html); [2021 Regs clean copy, 30 Dec 2025](https://old.uidai.gov.in/images/The_Aadhaar_Authentication_and_Offline_Verifications_Regulations_2021-_Clean_copy-30122025.pdf).
- UIDAI's stated goal is to end Aadhaar photocopying. [Medianama](https://www.medianama.com/2025/12/223-explained-uidais-new-rule-aadhaar-based-verification/) (Dec 2025).
- Status: likely.

**Storage rules.**

- Physical copies must be masked by redacting the first 8 digits before storage (2021 Regulations).
- Entities that store Aadhaar numbers must use an **Aadhaar Data Vault**. A 2024 UIDAI FAQ reportedly exempts OVSEs that do not authenticate from the ADV requirement. [Lexology](https://www.lexology.com/library/detail.aspx?g=391c2c88-0ab3-4d29-b88d-1a53c68e45c9).
- UIDAI guidance says OVSEs generally should not keep the Aadhaar number after offline verification.
- The DL Directions separately bar **any biometric data** from being collected or stored by the RE or the LSP unless a statute allows it.

**Conclusion.**

- Udofin calling a Surepass "Aadhaar OTP" endpoint with **Udofin's own account**, then storing the result, would be one of the following:
  - (a) authentication by an ineligible requesting entity, which risks Aadhaar Act Chapter VII offences and UIDAI action against the AUA chain; or
  - (b) offline e-KYC by an unregistered OVSE, after Dec 2025.
- In either case it also breaches the DL "basic minimal data" limit.
- **The Aadhaar step must be the RE's.** Use the RE's KUA/sub-KUA, the RE's e-KYC Setu access, or the RE's OVSE registration. Udofin hosts the screen only.

## 6. DigiLocker

- Private organisations can register as DigiLocker **Requesters** through the API Setu partner portal. Requirements include organisational digital signatures and domain email IDs; citizen consent is needed for each pull, and a Requester sees only the document types mapped to its approved service. [Partners SOP](https://cf-media.api-setu.in/resources/Partners-SOP.pdf).
- On 21 Sep 2026, NeGD published a **draft RFE for "Specialized Ecosystem Enablement Partners"**. These partners would onboard Requesters, starting with financial services. [NeGD notice](https://www.meity.gov.in/static/uploads/2026/09/e03f3d4baff2d57d1ffeb96d31f83c6a.pdf). It is a draft; Udofin could watch this as a possible lawful role.
- **For lending KYC, the RE must verify the digital signature and take the live photo** (see §4). So the DigiLocker pull should use the RE's Requester credentials, or those of the RE's KYC vendor, and go into RE storage.
- **Interpretation:** when DigiLocker delivers the Aadhaar XML, treat it as offline e-KYC that may trigger OVSE registration. Do this until UIDAI or NeGD clarify.

## 7. CKYC (CERSAI)

- **Access** (search, download, upload) is limited to registered reporting entities, which connect with digital signatures. Individuals and LSPs cannot log in. [Shufti guide](https://shuftipro.com/blog/ckyc-guide/); [SEBI copy of CKYCR operating guidelines](https://www.sebi.gov.in/sebi_data/commondocs/21072016_Annex3_p.pdf). Status: likely.
- **2025 changes:**
  - **OTP-based customer consent for downloads** (vendor-reported, around April 2025). [Trackwizz](https://helpdesk.trackwizz.com/support/solutions/folders/82000647562).
  - Replacement of CERSAI's API public key in live from 7 Nov 2025. [Complinity](https://complinity.com/legal-update/ckycrr-issues-replacement-of-cersai-public-key-in-ckycrr-api-services-20689/).
  - A reported 2026 move to multi-parameter search. Status: unverified.
  - The 29 Dec 2025 rule on reliance (see §2.2).
- **Timelines:** upload timelines under PML Rules r.9 are reported inconsistently (10 days versus 3 working days). [AML India](https://amlindia.in/ckycrr-compliance-guide/). Status: unverified.
- **KYC identifier:** the RE must communicate it to the customer. This is carried over from the 2016 MD; status likely.
- **Credit reporting link:** from 1 Jul 2026, credit institutions must report the **CKYC number** to the bureaus. The "Issue Date" field in UCRF consumer Form 1 becomes "CKYC number". [RBI draft 1st Amendment](https://website.rbi.org.in/web/rbi/-/notifications/reserve-bank-of-india-credit-information-reporting-1st-amendment-directions-2025-draft); [Business Standard](https://www.business-standard.com/finance/news/rbi-extends-credit-information-reporting-norms-july-1-2026-125120401312_1.html) (4 Dec 2025).

## 8. PAN verification

- The Income Tax Department has authorised **Protean's Online PAN Verification (OPV)** for "eligible entities". The list ties each category to a regulator's licence: banks, **RBI-approved NBFCs**, HFCs, PPI issuers, insurance web aggregators, and SEBI/IRDAI/PFRDA entities. Registration needs signed terms, an authorisation letter and a Digital Signature Certificate. [Protean OPV](https://www.proteantech.in/services/pan-opv/); [OPV FAQ](https://tinpan.proteantech.in/faqs/online-pan-verification/faq-pan-verify-general.html).
- **No LSP category appeared** in the snippets. Status: interpretation.
- **Recommendation:** run PAN checks through the RE's OPV registration or through an RE-contracted vendor whose legal source is documented.
- **PAN 2.0:** approved 25 Nov 2024. As of Aug 2026, the unified ITD portal was reportedly **not fully live**, and Protean/UTIITSL continue to operate. [ClearTax](https://cleartax.in/s/pan-2-0). Design for a change of endpoint.

## 9. Credit bureaus

**Who may receive credit information.**

- Under CICRA, credit information goes to credit institutions (members) and "specified users".
- **s.17(4)** bars a specified user from disclosing credit information to anyone else. [Text of s.17](https://lawgist.in/credit-information-companies-regulation-act/17).
- The **CIC (Amendment) Regulations 2021** (gazetted 29 Nov 2021) added clause (j) to Reg 3. RBI's **eligibility criteria of 5 Jan 2022** require:
  - incorporation in India;
  - information processing for credit institutions in the entity's objects;
  - **net worth of at least ₹2 crore**;
  - ownership and control by resident Indians, with diversified ownership;
  - **at least 3 years** of processing information for credit institutions;
  - a clean track record;
  - a CISA-certified IT-security audit.
- Sources: [RBI press release](https://website.rbi.org.in/documents/87730/39710918/PR1500aec612176eb3499dbb49e53be562f110.pdf) (5 Jan 2022); [Vinod Kothari](https://vinodkothari.com/2022/01/specified-users/); [Cyril Amarchand](https://corporate.cyrilamarchandblogs.com/2022/01/fig-paper-no-9-rbi-press-release-on-specified-users-new-year-relief-for-fintech-companies/).
- The **CIC Directions 2025** (28 Nov 2025) reportedly:
  - carry these criteria forward and tighten them;
  - state that a specified user sharing credit information with **any other person, including credit institutions**, violates s.17(4) and Reg 9;
  - require each bureau to tell its specified users so.
  - [TaxGuru](https://taxguru.in/rbi/rbi-credit-information-companies-directions-2025.html). Status: likely.
- **Background:** in 2019 RBI stopped banks and NBFCs from giving unregulated partners access to bureau data. [Business Standard](https://www.business-standard.com/article/companies/fintech-firms-in-a-spot-after-rbi-restricts-access-to-credit-data-119092800985_1.html).

**Consumer-consented sharing with entities that are not specified users.**

- The Credit Information Reporting MD of 6 Jan 2025 allows bureaus to share an individual's report **on consent** with an entity that is not a specified user, under an agreement and after due diligence. The entity:
  - acts as the individual's **authorised representative**;
  - may not use the data beyond the consent, or sell, resell or **pass it on**;
  - must keep it for no more than **6 months**, or until the purpose is served or consent is withdrawn, then delete it.
- Sources: [Medianama](https://www.medianama.com/2025/01/223-rbi-mandates-stricter-norms-credit-information-sharing/) (Jan 2025); [Moneylife](https://www.moneylife.in/article/rbi-revises-master-directions-on-reporting-of-customers-credit-information/76056.html); [FIDC copy of MD](https://www.fidcindia.org.in/wp-content/uploads/2025/01/RBI-CICs-MASTER-DIRECTIONS-06-01-25.pdf). Status: likely; confirm survival in the Nov 2025 CIC Directions.
- This is the **only** route by which Udofin could see a borrower's report. It **cannot be used to feed lenders.**

**"Soft pull".**

- In India, self-checks are usually treated by bureaus as non-scoring enquiries. A lender's enquiry for a credit decision is recorded on the report.
- No RBI rule defines a "soft pull". [IIFL explainer](https://www.iifl.com/index.php/blogs/credit-score/does-credit-check-reduce-credit-score). Status: interpretation.
- In a multi-lender comparison, **each RE that underwrites will generate its own enquiry.**

**Consumer protection.**

- Bureaus must send **SMS/email alerts** when a specified user accesses a report. [Outlook Money](https://www.outlookmoney.com/banking/cics-to-alert-customers-via-sms-or-email-on-credit-report-usage-rbi-issues-master-directions).
- Complaints not resolved within **30 calendar days** of first lodging carry **₹100 a day** compensation. This comes from the Oct 2023 circular, effective 26 Apr 2024. One reading allocates 21 days to the credit institution and 9 to the bureau. [Taxmann](https://www.taxmann.com/post/blog/rbi-mandates-cis-cics-to-compensate-complainants-with-rs-100-per-day-if-complaints-remain-unresolved-beyond-30-days/).

**Reporting by the RE.**

- Fortnightly reporting has applied since 1 Jan 2025.
- The **1st Amendment (issued 4 Dec 2025)** moves to **weekly incremental files plus a monthly full file from 1 Jul 2026** (deferred from 1 Apr 2026).
  - Final reporting dates are reported as the 9th, 16th, 23rd and last day of the month. The draft had used the 7th, 14th, 21st and 28th.
  - It also adds the CKYC-number field.
  - [Business Standard](https://www.business-standard.com/finance/news/rbi-extends-credit-information-reporting-norms-july-1-2026-125120401312_1.html); [OneFin](https://www.onefin.in/post/rbi-s-credit-reporting-overhaul-what-the-weekly-mandate-means-for-nbfcs).
- The DL Directions require **all lending through DLAs, including short-tenor and deferred-payment products**, to be reported to the bureaus. [Mondaq](https://www.mondaq.com/india/privacy-protection/1709322/rbi-introduced-digital-lending-direction-2025).
- This is directly relevant to Finbyx (LMS) and to the PAYDAY product.

## 10. Surepass: what it says it offers

- **Bureau products:** separate CIBIL, Experian, Equifax and CRIF report APIs, plus a "Multi Bureau Pull". Requests carry PAN, date of birth, mobile, name and a consent flag. [Multi-bureau](https://surepass.io/multi-bureau-pull-api/); [Experian](https://surepass.io/experian-credit-report-api/); [CRIF](https://surepass.io/crif-credit-report-api/).
- **Contradictory CIBIL page:** the CIBIL connector page states that "Surepass does not provide credit reports" and offers only "technical CIBIL API integration support". [CIBIL connector](https://surepass.io/cibil-credit-report-api/). Read this way, the client must have **its own bureau membership**. The TU CIBIL Connect FAQ also ties user IDs to the member organisation's nodal officer. [CIBIL FAQ](https://www.cibil.com/TUCIBILConnect/pdf/FAQForUser.pdf).
- **Aadhaar:** Surepass says clients need an AUA/KUA licence (or must become a sub-AUA/KUA through Surepass as a TSP). Its DigiLocker Aadhaar API is marketed to "any entities". [DigiLocker Aadhaar API](https://surepass.io/digilocker-aadhaar-verification-api/).
- **Not verified, because the docs could not be fetched:** whose membership or which AUA chain Surepass actually uses, its OVSE registration, and where it hosts data.
- **Treat Surepass as a technology service provider, not as the source of legal entitlement.** The entitlement must belong to the RE.

## 11. Recommended compliant architecture

1. **Contracts.**
   - An RE–LSP agreement with each NBFC appoints Udofin as a service provider: sourcing, UI, orchestration.
   - Each RE contracts Surepass (or its own KYC/bureau vendors) **in the RE's name**. Udofin can be a tri-partite technical integrator.
   - API keys are per RE and stored in a secrets vault scoped to that RE.
   - Udofin keeps a vendor-chain register: AUA/KUA, sub-KUA approval letter, OVSE registration, DigiLocker Requester ID, CERSAI and OPV registrations, bureau membership ID, hosting region.
2. **Pre-qualification without bureau data.**
   - Collect mobile (OTP login), name, PAN as entered (not verified by Udofin), date of birth, pincode, declared income and loan need.
   - The borrower picks or consents to specific lenders. Each consent is shown separately, with an "enquiry will appear on your credit report" notice.
3. **Lender-scoped KYC session.** For each selected RE, the app launches that RE's KYC flow (RE SDK or Udofin orchestration using the RE's credentials). The order of preference is:
   - (a) **CKYCR download** with OTP consent. Relying on the last uploader's identity/address verification is permitted under the 29 Dec 2025 amendment.
   - (b) **DigiLocker** under the RE's Requester ID, with signature verification and a live photo.
   - (c) **Aadhaar** only via the RE's own route: KUA/sub-KUA (if notified under s.11A), **e-KYC Setu**, or offline e-KYC/AVC as a **registered OVSE**.
   - (d) **V-CIP** by an RE official.
   - (e) PAN check through the RE's OPV or vendor.
   - Results stream to **RE-controlled storage in India**. Udofin keeps a status flag, an RE reference ID and the minimal contact data.
4. **Bureau.**
   - Each RE pulls through its own membership. The report sits in the RE's LOS (which may be Finbyx, as the RE's processor, logically separate).
   - Udofin receives only the offer (amount, APR, tenor, EMI, KFS link) for the multi-lender display. No report and no score.
5. **CKYC upload** by the RE that performed full CDD. The KYC identifier is sent to the customer; Udofin may display it.
6. **Data controls.**
   - No Aadhaar number anywhere in Udofin. Masked images only.
   - No biometrics.
   - Device permissions: one-time camera, microphone and location for KYC, with explicit consent. OTP read through the platform's consent-based SMS APIs, not broad SMS access.
   - India-only processing, including AI/LLM vendors.
   - Retention and deletion schedules.
   - Consent ledger mapped to DPDP. The DPDP Rules were notified 13/14 Nov 2025; consent-manager rules apply from 13 Nov 2026 and core duties from 13 May 2027. [Lawrbit](https://lawrbit.com/article/digital-personal-data-protection-rules-2025).
7. **Security.** Align with the RE's 31 Jul 2026 cyber directions as flowed down: a 6-hour incident window to the RE so it can meet its DAKSH reporting.

## 12. Items still to verify

- The operative paragraph numbers in RBI/DOR/2025-26/361 (V-CIP, OTP e-KYC caps, digital KYC, CKYCR).
- Whether the CIC Directions 2025 retained the consent-based sharing rules for non-specified users.
- The full list in S.O. 2597(E).
- UIDAI's OVSE-registration procedure and whether DigiLocker-delivered Aadhaar XML is covered.
- Surepass's actual legal chain.
- Which instrument the owner meant by "31 July 2026".

## Requirements-to-controls (structured)

| ID      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                               | Source                                                                                                                                        | Applies to | Status         | System control                                                                                                                                                                                                                                                               | Evidence                                                                                                                                      | Test case                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KYC-01  | Customer due diligence (identification, verification, risk categorisation, CKYC) for every loan is the lending RE's obligation. Udofin may only collect and forward data under the RE–LSP outsourcing agreement. KYC compliance decisions and loan sanction cannot be outsourced.                                                                                                                                         | RBI (NBFC – KYC) Directions 2025 (RBI/DOR/2025-26/361, 28 Nov 2025); outsourcing principles carried into the 2025 consolidation               | both       | likely         | Per-lender KYC case object owned by the RE. The KYC-complete decision can only be written by the RE's system or official (RE user ID). Udofin's ops portal has read-only KYC status.                                                                                         | Immutable log of the KYC decision: RE actor ID, method used, timestamp, document references in RE storage.                                    | An Udofin ops user tries to set KYC=complete or override a name mismatch: the request is rejected (403) and an audit entry is created.                                             |
| KYC-02  | Online Aadhaar authentication (OTP/biometric e-KYC) may be performed only by a bank, an RE notified under PMLA s.11A, or an RE using NPCI e-KYC Setu, under its own AUA/KUA/sub-KUA or Setu credentials. An LSP may not do it in its own name.                                                                                                                                                                            | Aadhaar Act s.4(4); PMLA s.11A; S.O. 2012(E) 5 May 2025; NPCI e-KYC Setu brochure                                                             | RE         | confirmed      | Lender capability registry (s11A_notified, kua_mode, setu_enabled, ovse_registered). Show the Aadhaar OTP e-KYC option only for lenders with a valid flag, and route the call through that lender's credentials. Udofin holds no UIDAI or Setu credentials of its own.       | Copy of each lender's gazette notification or UIDAI approval or Setu onboarding letter; API call logs showing the lender's licence key or ID. | A borrower selects a lender without a s.11A or Setu flag: the Aadhaar OTP option is hidden and DigiLocker, CKYCR or V-CIP are offered instead.                                     |
| KYC-03  | Accounts opened through OTP-based e-KYC in non-face-to-face mode need specific consent, aggregate term loans of no more than ₹60,000 a year, completion of full CDD within one year, and an OTP-based flag in CKYCR.                                                                                                                                                                                                      | RBI KYC framework (2016 MD provisions reported as carried into the 2025 entity-specific Directions)                                           | RE         | likely         | Product rule engine: if kyc_mode = AADHAAR_OTP, block a cumulative sanction above ₹60,000 in 12 months across that lender's loans to the borrower. Start a 1-year timer for full CDD. Pass the CKYCR flag to the lender.                                                     | Rule-engine decision logs; full-CDD due-date tracker per account.                                                                             | A PAYDAY application for ₹75,000 with OTP e-KYC is refused or diverted to V-CIP or DigiLocker KYC.                                                                                 |
| KYC-04  | Aadhaar must not be made mandatory; offer alternative officially valid documents. Only eligible REs may collect the Aadhaar number. Any stored copy or proof of possession must have the first 8 digits redacted.                                                                                                                                                                                                         | NBFC KYC Directions 2025; Aadhaar (Authentication and Offline Verification) Regulations 2021                                                  | both       | likely         | KYC method picker always offers non-Aadhaar options. On-device OCR masks the first 8 digits before upload. Data-loss-prevention scanning blocks 12-digit Aadhaar patterns in Udofin databases and logs.                                                                      | Masking-pipeline test reports; periodic DLP scan results.                                                                                     | Upload an unmasked Aadhaar image: the stored artefact shows XXXX-XXXX-1234, and no 12-digit value is found in the Postgres tables or logs.                                         |
| KYC-05  | Entities performing Aadhaar Paperless Offline e-KYC (XML) or Aadhaar Verifiable Credential (Aadhaar app) verification must register with UIDAI as OVSEs (Reg 13A, Dec 2025 amendment), obtain consent, and not retain the Aadhaar number. QR-code and e-Aadhaar checks are exempt from registration.                                                                                                                      | Aadhaar (Authentication and Offline Verification) Amendment Regulations, 2025 (around 9–12 Dec 2025); Aadhaar Act s.8A                        | RE         | likely         | Offline e-KYC and AVC flows run only under the lender's OVSE registration. The consent screen uses UIDAI-prescribed wording. The XML is parsed in the RE's environment and discarded; Udofin keeps no copy.                                                                  | Lender's OVSE registration certificate; consent logs; deletion logs.                                                                          | Try offline e-KYC for a lender with ovse_registered=false: the flow is blocked.                                                                                                    |
| KYC-06  | No biometric data may be collected or stored by the RE or the LSP unless a statute allows it. Entities storing Aadhaar numbers must use an Aadhaar Data Vault.                                                                                                                                                                                                                                                            | RBI (Digital Lending) Directions 2025; UIDAI Aadhaar Data Vault circular and FAQs                                                             | both       | confirmed      | No fingerprint or iris capture in the app. Liveness selfies and V-CIP media go only to RE storage. If the RE stores Aadhaar numbers, it uses a vault with reference tokens; Udofin stores tokens only.                                                                       | Data inventory showing no biometric fields in Udofin; RE's vault attestation.                                                                 | Static analysis of the app and backend finds no biometric SDK capture or storage path in Udofin systems.                                                                           |
| KYC-07  | Documents issued to DigiLocker are accepted as 'equivalent e-documents': the RE must verify the digital signature under the IT Act and take a live photo (digital KYC, with geo-coordinates). DigiLocker pulls need the citizen's consent and a registered Requester.                                                                                                                                                     | RBI KYC MD amendment (notification 11783) carried forward; DigiLocker/API Setu Partners SOP                                                   | RE         | likely         | DigiLocker OAuth runs under the lender's Requester client ID or the lender's KYC vendor. A signature-verification service runs in the RE environment. Live photo capture with GPS is a one-time permission.                                                                  | Signature verification results; live photo with lat/long and timestamp in RE storage; DigiLocker consent artefact.                            | A tampered PDF with an invalid signature is rejected; a valid DigiLocker document passes only once a live photo is captured.                                                       |
| KYC-08  | V-CIP (video KYC) must be conducted by a trained RE official, with liveness/spoof detection, face match, blocking of non-India or spoofed IPs, geo-tagged and time-stamped recordings, and an audit trail. Infrastructure and recordings stay under RE ownership, with no retention by the vendor.                                                                                                                        | NBFC KYC Directions 2025 (V-CIP provisions; RE-ownership details inherited from the 2016 MD)                                                  | RE         | likely         | Udofin only deep-links to the lender's V-CIP. No recording or transcript is stored by Udofin.                                                                                                                                                                                | RE's V-CIP audit logs; contract clause confirming no vendor retention.                                                                        | Connect from a non-Indian IP: the session is refused. Check Udofin storage: no video objects.                                                                                      |
| KYC-09  | CKYCR search, download and upload may be done only by reporting entities registered with CERSAI (downloads with OTP-based customer consent). The RE communicates the KYC identifier to the customer. An RE that downloads and relies on a current record need not re-verify identity or address (the RE that last uploaded is responsible) but remains responsible for all other CDD.                                     | NBFC KYC Amendment Directions, 29 Dec 2025 (Explanation under para 63); PML Rules r.9; CERSAI guidelines                                      | RE         | likely         | CKYC calls go only through each lender's CERSAI credentials. Store the identity of the last uploading RE and the record date. Send the KYC identifier to the borrower; Udofin may display it.                                                                                | CKYC API logs under the RE's FI code; OTP consent records; KYC identifier communication log.                                                  | Lender B downloads a record uploaded by Lender A: the system skips identity/address re-verification but still runs risk categorisation, sanctions screening and the purpose check. |
| KYC-10  | Periodic KYC updation: low-risk individuals may update within one year of the due date or by 30 Jun 2026, whichever is later. REs send three advance intimations and three reminders (at least one of each by letter), fully implemented by 1 Jan 2026.                                                                                                                                                                   | KYC Amendment Directions and circular RBI/2025-26/53 (12 Jun 2025)                                                                            | RE         | confirmed      | Re-KYC scheduler in the lender's LMS (for example Finbyx), with templated notices. Udofin can send app notifications only on the lender's instruction.                                                                                                                       | Delivery logs for all six communications per due account.                                                                                     | An account falls due: three pre-due notices and three post-due reminders are generated, including the letter channel.                                                              |
| AAD-01  | Appointing a sub-AUA or sub-KUA requires prior UIDAI approval (Reg 14(1)(ga)) using the revised application and joint undertaking, plus annual sub-entity audit undertakings.                                                                                                                                                                                                                                             | UIDAI Circular 02 of 2025 (7 Feb 2025); Aadhaar (Authentication and Offline Verification) Regulations 2021                                    | provider   | likely         | Vendor due-diligence gate: no Aadhaar API goes live without (a) the AUA/KUA identity, (b) a UIDAI approval letter naming the lender as sub-AUA/KUA, or Setu or OVSE proof, and (c) the latest audit undertaking.                                                             | Vendor compliance dossier per lender.                                                                                                         | Configuration attempts to enable an Aadhaar endpoint for a lender without uploaded approval documents: the deployment check fails.                                                 |
| PAN-01  | Online PAN verification through Protean's OPV is available to ITD-authorised eligible entities (banks, RBI-registered NBFCs, HFCs and others), registered with a DSC. No LSP category was seen.                                                                                                                                                                                                                           | Protean PAN OPV eligibility and registration pages                                                                                            | RE         | interpretation | PAN verification runs through the lender's OPV registration or a lender-contracted vendor. Store PAN masked (for example XXXXX1234X) in Udofin; the full PAN is held by the RE. Keep the endpoint configurable for the PAN 2.0 migration.                                    | Lender's OPV registration; vendor contract naming the lender.                                                                                 | Udofin's database shows only masked PAN; verification calls carry the lender's user ID.                                                                                            |
| CIC-01  | Credit information may be obtained only by credit institutions and RBI-approved specified users for permitted purposes. A specified user may not disclose it to any other person, including other credit institutions. CICs must tell specified users this.                                                                                                                                                               | CICRA 2005 s.17(4); CIC Regulations 2006 reg 9; RBI (CIC) Directions 2025 (28 Nov 2025)                                                       | both       | confirmed      | Bureau pulls run only with each lender's membership credentials. The report and score land in the lender's LOS. Udofin receives only offer outcomes (amount, APR, tenor, EMI, KFS link). No report or score fields exist in Udofin's schema.                                 | Bureau API logs under the lender's member ID; Udofin schema review; data-flow diagram signed off by the lender.                               | Search Udofin storage for bureau payload signatures (CIBIL/Experian/Equifax/CRIF report XML or JSON): none found.                                                                  |
| CIC-02  | Specified-user eligibility for a non-credit institution: incorporated in India; processing for credit institutions in its objects; net worth of at least ₹2 crore on a continuing basis; owned and controlled by resident Indians with diversified ownership; at least 3 years of experience processing information for credit institutions; clean track record; CISA-certified IT audit.                                 | CIC (Amendment) Regulations 2021 (clause (j) of Reg 3); RBI eligibility criteria press release (5 Jan 2022); carried into CIC Directions 2025 | LSP        | likely         | Product roadmap: assume Udofin is not a specified user. Revisit only after 3 years of operations and RBI approval.                                                                                                                                                           | Board note recording the eligibility assessment.                                                                                              | n/a (governance).                                                                                                                                                                  |
| CIC-03  | A bureau may share an individual's report on consent with an entity that is not a specified user, under an agreement and after due diligence. That entity acts only as the individual's authorised representative; may not use the data beyond the consent or sell, resell or pass it on; keeps it for at most 6 months (or until the purpose is met or consent is withdrawn); and needs fresh consent to keep it longer. | RBI Master Direction – Credit Information Reporting 2025 (6 Jan 2025); status under the CIC Directions 2025 to be verified                    | LSP        | likely         | Only if Udofin offers a borrower-facing credit-health feature under its own bureau agreement: separate data store, automatic deletion within 180 days, one-tap consent withdrawal with deletion, and a hard block on any flow to lenders, the AI agent or sister products.   | Bureau agreement; consent ledger; deletion job logs.                                                                                          | Withdraw consent: the report is deleted within the SLA. Try to attach the report to a loan application: blocked.                                                                   |
| CIC-04  | Bureaus must alert customers by SMS or email when a specified user accesses their report. Complaints not resolved within 30 calendar days attract ₹100 a day compensation, apportioned between the credit institution and the bureau.                                                                                                                                                                                     | RBI CIR Master Direction 2025 (6 Jan 2025); RBI circular on compensation (Oct 2023, effective 26 Apr 2024)                                    | RE         | likely         | Before each lender's pull, Udofin shows a notice that the check will appear on the report and trigger an alert. Bureau-related complaints received by Udofin go to the lender's nodal officer within 1 working day, with the 30-day clock and compensation exposure tracked. | Notice-display logs; complaint routing timestamps.                                                                                            | Lodge a bureau dispute in the app: it reaches the lender's queue the same day, and a breach alert fires on day 21.                                                                 |
| CIC-05  | Credit institutions report to bureaus fortnightly (since 1 Jan 2025). From 1 Jul 2026 they move to weekly incremental files (reported as the 9th, 16th, 23rd and last day of the month) plus a monthly full file, and include the CKYC number in the consumer UCRF.                                                                                                                                                       | RBI (Credit Information Reporting) (1st Amendment) Directions (issued 4 Dec 2025, effective 1 Jul 2026)                                       | RE         | likely         | Finbyx or the lender's LMS generates weekly incremental and monthly full files with a CKYC-number field. Udofin passes the CKYC identifier to the lender where available.                                                                                                    | File-generation and submission logs per bureau, with acknowledgements.                                                                        | A loan disbursed on the 10th appears in the 16th incremental file with its CKYC number.                                                                                            |
| CIC-06  | All lending through digital lending apps, including short-tenor and deferred-payment products, must be reported to bureaus by the RE.                                                                                                                                                                                                                                                                                     | RBI (Digital Lending) Directions 2025 (8 May 2025), now within Chapter III of the NBFC Credit Facilities Directions 2025                      | RE         | confirmed      | No 'unreported' product flag is allowed for PAYDAY or other short-tenor products. Reconcile disbursements with bureau submissions.                                                                                                                                           | Monthly reconciliation reports.                                                                                                               | A 15-day PAYDAY loan shows up in the next bureau file.                                                                                                                             |
| DATA-01 | The RE must ensure the LSP stores no borrower personal information except basic minimal data (name, address, contact details) needed for its services within the RE–LSP agreement.                                                                                                                                                                                                                                        | RBI (Digital Lending) Directions 2025                                                                                                         | both       | confirmed      | Udofin schema whitelist: name, address, mobile, email, application and lender reference IDs, KYC status, masked PAN. KYC images, Aadhaar XML, CKYC records and bureau reports live in lender-controlled storage in India, isolated per lender.                               | Data inventory and schema reviews; lender audit sign-off.                                                                                     | Automated schema check fails the build if a new column holds a document image, an unmasked ID or a bureau payload.                                                                 |
| DATA-02 | All digital-lending data must be stored only on servers in India. Data processed abroad must be deleted there and brought back to India within 24 hours.                                                                                                                                                                                                                                                                  | RBI (Digital Lending) Directions 2025                                                                                                         | both       | confirmed      | Supabase in the Mumbai region; Railway and other compute pinned to an Indian region or replaced. KYC and bureau data never sent to offshore LLM or analytics vendors; the AI agent uses India-hosted inference with redaction.                                               | Vendor data-residency attestations; egress monitoring.                                                                                        | Egress logs show no KYC or bureau fields leaving Indian regions.                                                                                                                   |
| DATA-03 | Only one-time access to camera, microphone and location, for onboarding or KYC, with explicit consent. No access to files, media, contacts, call logs or telephony functions.                                                                                                                                                                                                                                             | RBI (Digital Lending) Directions 2025                                                                                                         | both       | confirmed      | Permissions requested just in time at the KYC step and revoked or not reused afterwards. OTP auto-fill through the platform's consent-based SMS APIs instead of broad SMS reading. No location for collections.                                                              | App manifest review; permission-request telemetry.                                                                                            | After KYC completes, the app makes no further camera or location calls; the manifest has no READ_CONTACTS, READ_CALL_LOG or READ_SMS.                                              |
| DATA-04 | Purpose-specific consent for each rail (Aadhaar authentication under s.8 and offline verification under s.8A, DigiLocker pull, CKYC download OTP, each lender's bureau pull), recorded and auditable, aligned to the DPDP Rules 2025 timeline (consent-manager framework from 13 Nov 2026; core obligations from 13 May 2027).                                                                                            | Aadhaar Act ss.8, 8A; DPDP Rules 2025 (notified 13/14 Nov 2025)                                                                               | both       | likely         | Consent ledger recording rail, lender, purpose, text version, timestamp, device and IP, and withdrawal status. Lender-branded consent screens.                                                                                                                               | Consent artefacts exportable per application.                                                                                                 | For a sampled loan, produce separate consents for KYC and the bureau pull per lender; a missing artefact blocks disbursal.                                                         |
| SEC-01  | RBI's 31 Jul 2026 cybersecurity and technology-risk directions for NBFCs (reported as RBI/DoS/2026-27/461) and CICs (reported as /470) require incident reporting to RBI's DAKSH platform within 6 hours, with obligations flowing down to vendors.                                                                                                                                                                       | RBI supervisory cybersecurity directions, 31 Jul 2026 (secondary reports)                                                                     | RE         | likely         | Udofin incident-response runbook with notification to the lender well inside 6 hours, plus the security controls and audits required by the RE–LSP contract.                                                                                                                 | Incident drill reports; contractual SLA.                                                                                                      | In a tabletop exercise, a simulated breach of KYC orchestration reaches the lender's CISO within 2 hours.                                                                          |
| REC-01  | Identity and KYC records must be kept for the PMLA-prescribed period after the business relationship ends.                                                                                                                                                                                                                                                                                                                | PML (Maintenance of Records) Rules 2005 (retention period not re-verified in this session)                                                    | RE         | unverified     | Retention is held by the lender. Udofin deletes its minimal data under its own schedule and never acts as the KYC system of record.                                                                                                                                          | Lender retention policy; Udofin deletion logs.                                                                                                | A closed account past Udofin's retention window has no Udofin-side personal data, while the lender's record still exists.                                                          |

## Challenges to the owner's plan

1. CIBIL 'soft pull' by Udofin. Udofin is not a credit institution or specified user and cannot realistically qualify soon: the RBI criteria of 5 Jan 2022 require ₹2 crore net worth, Indian ownership and control, at least 3 years of processing information for credit institutions, and a CISA-certified IT audit. Even a specified user may not pass a report to lenders (CICRA s.17(4); CIC Directions 2025). The non-specified-user consent route forbids passing the data on and caps retention at 6 months. India has no regulatory 'soft pull'. RECOMMEND: each lender pulls through its own membership and the report goes to the lender's system. Udofin pre-qualifies on self-declared data, tells borrowers that each selected lender's check will appear on their report and trigger a bureau alert, and lets borrowers limit which lenders run checks.
2. 'Aadhaar fetched via OTP' through Udofin's Surepass account. Online Aadhaar e-KYC is limited to banks, REs notified under PMLA s.11A, or REs using NPCI e-KYC Setu. Sub-AUA/sub-KUA status needs prior UIDAI approval (Reg 14(1)(ga); UIDAI Circular 02/2025) and a s.4(4) basis that an LSP lacks. Surepass itself says clients need an AUA/KUA licence. Since December 2025, Paperless Offline e-KYC (XML) and AVC verification also require OVSE registration with UIDAI. RECOMMEND: the Aadhaar step runs under each lender's own credentials (its KUA/sub-KUA, e-KYC Setu, or OVSE registration), or is replaced by DigiLocker, CKYCR or V-CIP. Udofin only hosts the screen and never stores the Aadhaar number.
3. The Good Governance Rules amendment of 31 Jan 2025 is not a shortcut. Approval goes through a sponsoring ministry, UIDAI and MeitY, no lending or LSP use case has been published, and KYC for loans is governed by PMLA. Do not build the product on getting such an approval.
4. CKYC by Udofin. CKYCR search, download and upload are restricted to registered reporting entities, and downloads now carry OTP-based customer consent. RECOMMEND: each lender searches, downloads and uploads through its own CERSAI credentials. 'KYC once, reuse across lenders' must work through CKYCR under the 29 Dec 2025 rule on relying on the last uploader's verification, not through Udofin's database.
5. Udofin as the central KYC store for multi-lender comparison (Supabase holding Aadhaar/PAN images, CKYC data and bureau reports). The DL Directions require lenders to ensure LSPs keep only basic minimal data (name, address, contact), store data only in India, and collect or store no biometrics. RECOMMEND: KYC artefacts and reports live in lender-controlled storage in India. Udofin keeps tokens, status flags and masked references only, with per-lender separation of data and keys.
6. Treating KYC as Udofin's function. KYC compliance decisions and loan sanction cannot be outsourced by an NBFC. RECOMMEND: the lender's system or official records each KYC decision. Udofin's operations portal must not be able to mark KYC complete or override a mismatch.
7. PAN verification and DigiLocker in Udofin's own name. Protean's online PAN verification lists regulated categories, with no LSP category seen. Lending KYC on DigiLocker documents needs the lender to verify the digital signature and take a live photo. RECOMMEND: use the lender's OPV registration and DigiLocker Requester ID, or the lender's own vendor contract. Watch NeGD's draft enablement-partner scheme (notice of 21 Sep 2026) for a possible lawful role for Udofin.
8. The Surepass contract as the legal basis. Surepass's CIBIL page says it 'does not provide credit reports' and offers only integration support, which implies the client's own membership is needed. RECOMMEND: re-paper the contract as lender-named or tri-partite, and get written confirmation of whose bureau membership, AUA/KUA chain and OVSE registration are used and where data is hosted. Do not go live on any API whose legal chain is not documented.
9. PAYDAY and other small-ticket loans on OTP e-KYC. OTP e-KYC accounts are capped at ₹60,000 of aggregate term loans a year (carried over from the 2016 rules; likely), are open only to eligible lenders, and need full KYC within a year. All digital-lending loans, whatever the tenor, must be reported to bureaus, and weekly reporting with a CKYC-number field starts 1 Jul 2026. RECOMMEND: build these caps and the reporting cadence into the product rules and Finbyx.
10. Phone permissions. The DL Directions allow only one-time access to camera, microphone and location for onboarding or KYC, with explicit consent, and bar access to files, media, contacts, call logs and telephony. RECOMMEND: request permissions only at the KYC step, use the platform's consent-based OTP auto-fill instead of broad SMS reading, and never use location for collections.
11. The AI agent and the sister products (Equator, Finbyx, LawDocsComply). Bureau reports cannot be passed on (s.17(4)), and the minimal-data and India-localisation rules apply (offshore processing must be deleted and brought back within 24 hours). RECOMMEND: the AI agent gets no access to raw KYC or bureau data and runs on India-hosted inference. Finbyx acts only as each lender's processor, kept separate from Udofin. No KYC or bureau data goes to Equator or LawDocsComply.
12. The 5% FLDG gives Udofin no KYC or bureau rights. DLG is capped at 5% under the NBFC Credit Facilities Directions, and taking on default risk does not make Udofin a credit institution or specified user. Keep its KYC and bureau role unchanged.
13. The '31 July 2026 master directions' premise. What RBI issued that day were supervisory cybersecurity and technology-risk directions for NBFCs, CICs, banks and others (6-hour incident reporting through DAKSH; obligations flow down to vendors), not new KYC or credit-bureau directions. RECOMMEND: ask the owner which instrument was meant, and build Udofin's security controls to the NBFC and CIC cyber directions as its lenders will flow them down.

## Open questions

- Which partner NBFCs are notified under PMLA s.11A, hold KUA/sub-KUA status, use NPCI e-KYC Setu, are registered as OVSEs with UIDAI (post-Dec 2025), hold DigiLocker Requester IDs, have Protean OPV registration and CERSAI CKYCR credentials, and are members of all four bureaus?
- Surepass's legal chain: for each bureau (CIBIL, Experian, Equifax, CRIF), whose membership or specified-user credentials are used? Under which AUA/KUA, and with what UIDAI sub-AUA/KUA approval, does its Aadhaar product run? Is it a registered OVSE? Where is data hosted and for how long? (The docs could not be fetched in this session.)
- The operative text and paragraph numbers of RBI/DOR/2025-26/361 (NBFC KYC Directions 2025, as amended 29 Dec 2025): V-CIP infrastructure and ownership rules, OTP e-KYC caps (₹60,000 / one year), digital KYC, reliance on third-party due diligence, CKYCR upload timelines. The RBI site was unreachable from this environment.
- Did the CIC Directions 2025 (28 Nov 2025) keep, change or withdraw the January 2025 rules on consent-based sharing with entities that are not specified users (authorised representative, no pass-on, 6-month retention)?
- The full list of entities in S.O. 2597(E) of 21 May 2026 (PMLA s.11A notification). Do any of Udofin's intended lenders appear in it or in S.O. 2012(E) of 5 May 2025?
- Does Aadhaar XML delivered through DigiLocker count as 'Paperless Offline e-KYC' that needs OVSE registration under the new Reg 13A? What is UIDAI's OVSE registration procedure and timeline?
- The final weekly credit-reporting dates (9th/16th/23rd/last day versus the draft's 7th/14th/21st/28th) and the final UCRF field changes effective 1 Jul 2026.
- Which instrument did the owner mean by 'RBI master directions issued on July 31, 2026'? Only the supervisory cybersecurity/technology-risk directions (and possibly a CIC miscellaneous supervisory direction) were found for that date.
- Does Udofin want a borrower-facing credit-health feature? If so, it would need a direct agreement with a bureau under the consent-based route for entities that are not specified users. Counsel should say whether that is compatible with the DL Directions' minimal-data limit on LSPs.
- Does the owner plan for Udofin, or a group entity, to become an RE (for example, an NBFC)? That would change its PMLA, CICRA and UIDAI eligibility analysis.
- The exact current CKYCR upload and update timelines under PML Rules r.9 (sources conflict: 10 days versus 3 working days) and the CERSAI OTP-consent download procedure.

## Sources

- [RBI (NBFC – Know Your Customer) Directions, 2025 (RBI/DOR/2025-26/361)](https://rbidocs.rbi.org.in/rdocs/notification/PDFs/361MD1E2F8EA063454AD5AFA1D02A1BA5ACA7.PDF) 2025-11-28 (primary) (not fetched)
- [Signzy – RBI KYC Master Directions 2025 key changes](https://www.signzy.com/blogs/RBI-KYC-Master-Directions-2025-key-changes) (not fetched)
- [HyperVerge – KYC for NBFCs (2026)](https://hyperverge.co/blog/kyc-for-nbfcs/) (not fetched)
- [Vinod Kothari – Year in Review: Regulatory Developments for NBFCs 2025](https://vinodkothari.com/wp-content/uploads/2026/01/RBI-Regulatory-Developments-2025-1.pdf) 2026-01 (not fetched)
- [Lexplosion – RBI amends KYC Directions: responsibility lies with RE that last uploaded/updated CKYCR record](https://lexplosion.in/rbi-amends-kyc-directions-clarifying-that-the-responsibility-of-verification-of-identity-address-will-lie-with-the-re-that-has-last-uploaded-updated-the-customers-kyc-records-in-ckycr/) 2025-12 (not fetched)
- [Mehta & Mehta – NBFC KYC Amendment Directions 2025](https://mehta-mehtaadvisory.com/rbi-update-reserve-bank-of-india-non-banking-financial-companies-know-your-customer-amendment-directions-2025/) 2025-12 (not fetched)
- [RBI KYC Amendment Directions 29.12.2025 (RBI/2025-26/166) – vendor-hosted copy](https://trackwizz.com/knowledge-hub/wp-content/uploads/2025/12/RBI-KYC-Amendment-Directions-2025-29.12.2025.pdf) 2025-12-29 (primary) (not fetched)
- [RBI – Updation/Periodic updation of KYC – revised instructions](https://website.rbi.org.in/web/rbi/-/notifications/updation/-periodic-updation-of-kyc-revised-instructions-1) 2025-06-12 (primary) (not fetched)
- [RBI/2025-26/53 circular (FIDC copy)](https://www.fidcindia.org.in/wp-content/uploads/2025/06/RBI-UPATION-OF-KYC-12-06-25.pdf) 2025-06-12 (primary) (not fetched)
- [TaxGuru – RBI KYC Amendment Directions 2025 (June)](https://taxguru.in/rbi/reserve-bank-india-know-customer-kyc-amendment-directions-2025.html) 2025-06 (not fetched)
- [CAclubindia – Finance Ministry notifies five NBFCs for Aadhaar authentication under PMLA](https://www.caclubindia.com/news/finance-ministry-notifies-five-nbfcs-for-aadhaar-based-authentication-under-pmla-24820.asp) 2025-05 (not fetched)
- [Vinod Kothari – Online Authentication of Aadhaar: Exclusive Club, Members Only](https://vinodkothari.com/2025/05/online-authentication-of-aadhaar-exclusive-club-members-only/) 2025-05 (not fetched)
- [Vinod Kothari – Setu-ing the Standard: NPCI's New Path to Aadhaar e-KYC](https://vinodkothari.com/2025/08/setu-ing-the-standard-npcis-new-path-to-aadhaar-e-kyc/) 2025-08 (not fetched)
- [NPCI – e-KYC Setu System Product Brochure](https://www.npci.org.in/PDF/e-kyc-setu-system/Product-Brochure.pdf) (primary) (not fetched)
- [TaxGuru – SEBI allows NPCI e-KYC Setu](https://taxguru.in/sebi/sebi-npci-e-kyc-setu-aadhaar-kyc.html) 2025-06 (not fetched)
- [RBI – NBFC application for Aadhaar e-KYC (KUA/sub-KUA) licence](https://rbidocs.rbi.org.in/rdocs/notification/PDFs/EKYCCD5A7A5B2F70471883B6E45D84E35855.PDF) 2021-09 (primary) (not fetched)
- [Vinod Kothari – NBFCs licensed for KYC authentication](https://vinodkothari.com/2021/09/nbfcs-licensed-for-kyc-authentication/) 2021-09 (not fetched)
- [Aadhaar Good Governance Portal – Acts/Rules (SWIK)](https://swik.meity.gov.in/rules) (primary) (not fetched)
- [PIB – Aadhaar Good Governance portal launched](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2106755) 2025-02-27 (primary) (not fetched)
- [Legal500 – Aadhaar Authentication for Private Entities: 2025 Amendment](https://www.legal500.com/intelligence/india/privacy/aadhaar-authentication-for-private-entities-navigating-the-2025-amendment) 2025 (not fetched)
- [UIDAI Circular 02 of 2025 – Sub-AUA/Sub-KUA application form & joint undertaking](https://uidai.gov.in/images/Circular_2_of_2025_Amended__Sub-AUA_and_Sub-KUA_application_form__Joint_Undertaking.pdf) 2025-02-07 (primary) (not fetched)
- [UIDAI – Undertaking letter to AUA/KUA (sub-AUA audits)](https://uidai.gov.in/images/Undertaking_letter_to_AUA_KUA.pdf) 2025 (primary) (not fetched)
- [Aadhaar (Authentication and Offline Verification) Regulations 2021 – clean copy 30.12.2025](https://old.uidai.gov.in/images/The_Aadhaar_Authentication_and_Offline_Verifications_Regulations_2021-_Clean_copy-30122025.pdf) 2025-12-30 (primary) (not fetched)
- [UIDAI – Regulations page](https://uidai.gov.in/en/about-uidai/legal-framework/regulations.html) (primary) (not fetched)
- [Vinod Kothari – A New Way to Verify Aadhaar Offline: Face Matching](https://vinodkothari.com/2025/12/a-new-way-to-verify-aadhaar-offline-introduction-of-face-matching/) 2025-12 (not fetched)
- [Legal500 – Aadhaar Authentication and Offline Verification Amendment Regulations 2025](https://www.legal500.com/intelligence/india/compliance/aadhaar-authentication-and-offline-verification-amendment-regulations-2025-strengthening-india's-digital-identity-framework) 2025-12 (not fetched)
- [Medianama – UIDAI's new rule on Aadhaar-based verification](https://www.medianama.com/2025/12/223-explained-uidais-new-rule-aadhaar-based-verification/) 2025-12 (not fetched)
- [Aadhaar Act 2016 as amended (UIDAI)](https://uidai.gov.in/images/Aadhaar_Act_2016_as_amended.pdf) (primary) (not fetched)
- [India Code – Aadhaar Act Section 8A](https://www.indiacode.nic.in/show-data?actid=AC_CEN_37_85_00001_201618_1517807328460&sectionId=49433&sectionno=8A&orderno=10) (primary) (not fetched)
- [Lexology – UIDAI clarifications on Aadhaar Data Vault applicability](https://www.lexology.com/library/detail.aspx?g=391c2c88-0ab3-4d29-b88d-1a53c68e45c9) (not fetched)
- [RBI – Amendment to MD on KYC (equivalent e-document, DigiLocker, V-CIP)](https://website.rbi.org.in/web/rbi/-/notifications/amendment-to-master-direction-md-on-kyc-11783) 2020-01 (primary) (not fetched)
- [API Setu – DigiLocker Partners SOP](https://cf-media.api-setu.in/resources/Partners-SOP.pdf) (primary) (not fetched)
- [NeGD Public Notice – draft RFE for DigiLocker Specialized Ecosystem Enablement Partners](https://www.meity.gov.in/static/uploads/2026/09/e03f3d4baff2d57d1ffeb96d31f83c6a.pdf) 2026-09-21 (primary) (not fetched)
- [HyperVerge – What RBI requires for Video KYC (2026)](https://hyperverge.co/blog/rbi-video-kyc-guidelines/) (not fetched)
- [IDfy – RBI's direction on V-CIP](https://www.idfy.com/blog/rbis-direction-on-v-cip-video-kyc/) (not fetched)
- [Shufti – CKYC guide (KIN, 2026 rules)](https://shuftipro.com/blog/ckyc-guide/) (not fetched)
- [Trackwizz – CERSAI/RBI/SEBI regulatory updates (OTP consent for CKYC download)](https://helpdesk.trackwizz.com/support/solutions/folders/82000647562) 2025 (not fetched)
- [AML India – CKYCRR compliance guide](https://amlindia.in/ckycrr-compliance-guide/) (not fetched)
- [Complinity – CERSAI public key replacement in CKYCRR API](https://complinity.com/legal-update/ckycrr-issues-replacement-of-cersai-public-key-in-ckycrr-api-services-20689/) 2025-11 (not fetched)
- [SEBI-hosted CKYCR Operating Guidelines](https://www.sebi.gov.in/sebi_data/commondocs/21072016_Annex3_p.pdf) 2016-07 (primary) (not fetched)
- [Protean – PAN OPV (online PAN verification by authorised entities)](https://www.proteantech.in/services/pan-opv/) (primary) (not fetched)
- [Protean – Online PAN Verification FAQs](https://tinpan.proteantech.in/faqs/online-pan-verification/faq-pan-verify-general.html) (primary) (not fetched)
- [ClearTax – PAN 2.0](https://cleartax.in/s/pan-2-0) (not fetched)
- [RBI press release – Eligibility criteria for Specified Users of CICs](https://website.rbi.org.in/documents/87730/39710918/PR1500aec612176eb3499dbb49e53be562f110.pdf) 2022-01-05 (primary) (not fetched)
- [Vinod Kothari – Circulation of credit information: Specified Users](https://vinodkothari.com/2022/01/specified-users/) 2022-01 (not fetched)
- [Cyril Amarchand – FIG Paper 9: RBI press release on specified users](https://corporate.cyrilamarchandblogs.com/2022/01/fig-paper-no-9-rbi-press-release-on-specified-users-new-year-relief-for-fintech-companies/) 2022-01 (not fetched)
- [CICRA 2005 Section 17 text](https://lawgist.in/credit-information-companies-regulation-act/17) (not fetched)
- [TaxGuru – RBI (Credit Information Companies) Directions, 2025](https://taxguru.in/rbi/rbi-credit-information-companies-directions-2025.html) 2025-11-28 (not fetched)
- [TaxGuru – RBI (NBFC – Credit Information Reporting) Directions, 2025](https://taxguru.in/rbi/rbi-non-banking-financial-companies-credit-information-reporting-directions-2025.html) 2025-11-28 (not fetched)
- [Business Standard – Fintech firms in a spot after RBI restricts access to credit data](https://www.business-standard.com/article/companies/fintech-firms-in-a-spot-after-rbi-restricts-access-to-credit-data-119092800985_1.html) 2019-09-28 (not fetched)
- [RBI Master Direction – Credit Information Reporting 2025 (FIDC copy)](https://www.fidcindia.org.in/wp-content/uploads/2025/01/RBI-CICs-MASTER-DIRECTIONS-06-01-25.pdf) 2025-01-06 (primary) (not fetched)
- [Medianama – RBI mandates stricter norms for credit information sharing](https://www.medianama.com/2025/01/223-rbi-mandates-stricter-norms-credit-information-sharing/) 2025-01 (not fetched)
- [Moneylife – RBI revises MD on reporting of customers' credit information](https://www.moneylife.in/article/rbi-revises-master-directions-on-reporting-of-customers-credit-information/76056.html) 2025-01 (not fetched)
- [Outlook Money – CICs to alert customers via SMS/email on credit report usage](https://www.outlookmoney.com/banking/cics-to-alert-customers-via-sms-or-email-on-credit-report-usage-rbi-issues-master-directions) 2025-01 (not fetched)
- [Taxmann – Rs 100/day compensation for unresolved CIC complaints beyond 30 days](https://www.taxmann.com/post/blog/rbi-mandates-cis-cics-to-compensate-complainants-with-rs-100-per-day-if-complaints-remain-unresolved-beyond-30-days/) 2023-10 (not fetched)
- [Business Standard – RBI defers credit information reporting norms to July 1, 2026](https://www.business-standard.com/finance/news/rbi-extends-credit-information-reporting-norms-july-1-2026-125120401312_1.html) 2025-12-04 (not fetched)
- [RBI – Credit Information Reporting (1st Amendment) Directions 2025 – Draft](https://website.rbi.org.in/web/rbi/-/notifications/reserve-bank-of-india-credit-information-reporting-1st-amendment-directions-2025-draft) 2025 (primary) (not fetched)
- [OneFin – RBI's credit reporting overhaul: weekly mandate for NBFCs](https://www.onefin.in/post/rbi-s-credit-reporting-overhaul-what-the-weekly-mandate-means-for-nbfcs) 2026 (not fetched)
- [IIFL – Soft vs hard inquiry explained](https://www.iifl.com/index.php/blogs/credit-score/does-credit-check-reduce-credit-score) (not fetched)
- [RBI (Digital Lending) Directions, 2025 – text mirror](https://littdb.sfo2.cdn.digitaloceanspaces.com/litt/IN/RBI/notifications/RBI_12848.html) 2025-05-08 (primary) (not fetched)
- [Mondaq – RBI introduced Digital Lending Direction, 2025](https://www.mondaq.com/india/privacy-protection/1709322/rbi-introduced-digital-lending-direction-2025) 2025 (not fetched)
- [Lexplosion – RBI issues consolidated guidelines on Digital Lending](https://lexplosion.in/rbi-issues-consolidated-guidelines-on-digital-lending-effective-immediately/) 2025-05 (not fetched)
- [TaxGuru – RBI (NBFC – Credit Facilities) Directions, 2025](https://taxguru.in/rbi/rbi-non-banking-financial-companies-credit-facilities-directions-2025.html) 2025-11-28 (not fetched)
- [RBI Master Directions page (id 12957) – NBFC Credit Facilities](https://rbi.org.in/SCRIPTs/BS_ViewMasDirections.aspx?id=12957) (primary) (not fetched)
- [TaxGuru – RBI NBFC Cybersecurity & Technology Risk Directions, 2026](https://taxguru.in/rbi/rbi-issues-nbfc-cybersecurity-technology-risk-directions-2026-governance-framework.html) 2026-07-31 (not fetched)
- [Bitscore – RBI Cybersecurity Directions 2026 – all seven explained](https://www.bitscore.in/resources/rbi-cybersecurity-directions-2026) 2026-08 (not fetched)
- [RBI/DoS/2026-27/410 (Commercial Banks cybersecurity) – copy](https://www.lexsite.com/eDocs/RBI-DoS-410.pdf) 2026-07-31 (primary) (not fetched)
- [Legal500 – RBI Amendments 2026: Type I NBFC category](https://www.legal500.com/developments/thought-leadership/rbi-amendments-2026-a-new-category-for-nbfc-registration-and-exemptions/) 2026 (not fetched)
- [Surepass – Multi Bureau Pull API](https://surepass.io/multi-bureau-pull-api/) (not fetched)
- [Surepass – TransUnion CIBIL Report Connector](https://surepass.io/cibil-credit-report-api/) (not fetched)
- [Surepass – Experian Credit Report API](https://surepass.io/experian-credit-report-api/) (not fetched)
- [Surepass – CRIF Credit Report API](https://surepass.io/crif-credit-report-api/) (not fetched)
- [Surepass – Aadhaar Authentication API](https://surepass.io/aadhaar-authentication-api/) (not fetched)
- [Surepass – How to become a UIDAI Sub-AUA](https://surepass.io/blog/how-to-become-a-uidai-sub-aua-step-by-step-guide/) (not fetched)
- [Surepass – DigiLocker Aadhaar Verification API](https://surepass.io/digilocker-aadhaar-verification-api/) (not fetched)
- [TU CIBIL Connect – FAQ for users](https://www.cibil.com/TUCIBILConnect/pdf/FAQForUser.pdf) (primary) (not fetched)
- [Lawrbit – Digital Personal Data Protection Rules, 2025](https://lawrbit.com/article/digital-personal-data-protection-rules-2025) 2025-11 (not fetched)
