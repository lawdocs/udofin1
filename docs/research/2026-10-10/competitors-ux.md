# Indian Digital Lending Apps and LSP Marketplaces: Competitive Landscape, UX Teardown and MVP Recommendations for Udofin (as of 2026-10-10)

**Executive summary.** India's digital-lending front end has consolidated around three archetypes. (1) **Payments and wealth super-apps acting as LSPs**: PhonePe, Google Pay, CRED, Groww and Paytm embed lender-branded offers in an app the user already trusts. Several are now **buying or building their own NBFC**: Amazon closed its purchase of axio in Sept 2025, and Groww lends through Groww Creditserv. (2) **Pure marketplaces/LSPs**: Paisabazaar and BankBazaar for unsecured credit, Volt Money for loans against mutual funds (LAMF), Rupeek for gold. (3) **NBFC-owned digital lending apps**: Money View, KreditBee, Fibe, Kissht, Freo, mPokket, Bajaj Finserv, Tata Capital and Poonawalla. The regulator now sets much of the UX directly. Since **1 Nov 2025**, para 6 of the RBI (Digital Lending) Directions, 2025 requires a multi-lender LSP to show **all matching offers in an unbiased "digital view"**. Each offer must show lender name, amount, tenor, APR, EMI, penal charges and a KFS link. The **names of lenders that did not match** must also be shown, and steering by dark patterns is prohibited. Since July 2025 RBI publishes a **public list of DLAs**, and Google Play now admits Indian personal-loan apps only if they are on that list. Play also bars loan apps from contacts, photos/media, precise location and call logs. Today a fast, compliant journey reaches an **offer screen in about 7–9 user interactions** (mobile, OTP, consents, PAN, amount/income). Full KYC, KFS acceptance, mandate and eSign come **after** the user picks a lender. Udofin's plan to do Aadhaar OTP, DigiLocker, CKYC and a bureau pull by Udofin _before_ offers adds friction, and it also has legal problems: the RE, not the LSP, does KYC and pulls the bureau report. Several owner requirements conflict with RBI or app-store rules: location/OTP-reading permissions, a PFM "books of accounts" view, PAYDAY loans, PayPal/Stripe for repayments, and Equator as the grievance escalation path. **Recommended MVP:** a narrow, secured-first marketplace. Start with LAMF/LAS, then unsecured personal loans from 2–4 partner REs, plus a compliant multi-lender offer screen, a KFS viewer, UPI Autopay/eNACH set up in the RE's name, and a visible grievance-officer page. Add other products only once these work.

> **Method and limitations (read first).** The task called for 10–30 searches/fetches. About 25 web searches were completed before the shared web-search budget ran out. **WebFetch failed with DNS errors (`ENOTFOUND`) for every domain tried** (rbi.org.in, support.google.com, rbihub.in, medianama.com, groww.in), so **no primary document could be opened in full**. Claims below are therefore based on (a) search-engine extracts of primary pages (RBI press release, Google Play help page, PhonePe and Groww pages, App Store listings) and (b) secondary sources (law-firm notes, Medianama, Inc42, TechCrunch). Points drawn from background knowledge (training data to mid-2026) that could not be re-checked this session are marked **[unverified]**. Para numbers are cited only where a source gave them.

---

## Findings

### 1. Regulatory UX baseline that every competitor now works within

**1.1 Multi-lender offer display (the most important UX rule for Udofin).**

- The RBI (Digital Lending) Directions, 2025 were issued on **8 May 2025**. Most provisions applied immediately. The multi-lender LSP provision (**para 6**) took effect on **1 Nov 2025** **[confirmed — multiple secondary sources]** ([Saraf & Partners](https://sarafpartners.com/rbi-notifies-the-rbi-digital-lending-directions-2025/) (2025); [Legal500](https://www.legal500.com/developments/thinked-leadership/the-rbis-digital-lending-directions-2025-a-unified-code-for-a-fragmented-sector/) (2025)). The circular index is on [RBI](https://www.rbi.org.in/Scripts/BS_CircularIndexDisplay.aspx?Id=12848) but could not be fetched.
- What para 6 requires **[confirmed — secondary, consistent across sources]** ([Mondaq](https://www.mondaq.com/india/financial-services/1651878/rbi-digital-lending-directions-2025-same-same-but-different) (2025); [Legistify](https://legistify.com/blogs/rbi-digital-lending-directions-clm-guide-for-lenders/) (2025–26); [Hammurabi & Solomon](https://www.hammurabisolomon.in/post/reserve-bank-of-india-digital-lending-directions-2025-brief-overview-analysis) (2025)):
  - The RE must ensure the LSP shows **every offer that matches the borrower's request**, in an **unbiased, objective digital view**.
  - The **names of lenders that did not offer** must also be disclosed.
  - Each offer must show: **RE name, loan amount, tenor, APR, monthly repayment (EMI), penal charges, and a link to that RE's KFS**.
  - The matching logic must be **consistent for similarly placed borrowers**, and both the logic and any changes to it must be documented.
  - **Dark patterns or deceptive design that steer the borrower to a particular offer are prohibited**.
- Sources differ on whether a "KFS menu" or a per-offer KFS link is required ([Leegality](https://www.leegality.com/blog/digital-lending-directions-2025) (2025)). Build per-offer links, which satisfy both readings **[interpretation]**.
- **Obligation sits on the RE** to ensure it, and is carried out by the **LSP** (Udofin).

**1.2 Public DLA list and CIMS reporting.** REs had to report their DLAs on RBI's CIMS portal. Reporting opened by 13 May 2025, with initial data due by 15 June 2025. RBI said it would publish a public list ("Citizen's Corner → DLAs deployed by Regulated Entities") by 1 July 2025 **[confirmed — RBI press release via search extract]** ([RBI press release prid=60403](https://rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=60403) (2025); [Medianama](https://www.medianama.com/2025/05/223-rbi-digital-lending-apps-centralised-directory/) (May 2025)).

- RBI says the list is "as is", built from RE submissions without validation, and is meant only to help customers verify a DLA's association with an RE.
- **Effect for Udofin:** Udofin's app must appear on the list **for each partner RE**, so every partner must report it. **Obligation: RE (reporting); LSP (supplying data).**

**1.3 Google Play Personal Loans policy (India).**

- Google's India help page requires a valid RBI licence **and** that the app appear on RBI's public DLA list. Facilitators must say so in the Personal Loan App Declaration **[confirmed — Google help page via search extract]** ([Google Play Financial Services policy](https://support.google.com/googleplay/android-developer/answer/9876821?hl=en) (current, fetched only via extract)).
- Since **31 May 2023**, apps that provide or facilitate personal loans, including lead generators, may not access **external storage, photos, videos, contacts, precise location, phone numbers or call logs** **[confirmed — secondary]** ([TechCrunch](https://techcrunch.com/2023/04/05/google-personal-loan-apps-update/) (Apr 2023); [Business Today](https://www.businesstoday.in/tech-today/trending/story/google-to-restrict-personal-loan-apps-from-play-store-starting-today-383608-2023-05-31) (May 2023)).
- Facilitators must **prominently list all partner NBFC/bank names in the store description**, with links to lender sites that list the app as their agent **[likely — 2022 secondary, current wording not verified]** ([Deccan Herald](https://www.deccanherald.com/amp/story/technology%2Fgoogle-revises-personal-loan-apps-policy-in-india-blocks-access-to-photos-contacts-1207306.html) (2022/23)).
- Google's global policy also **bars personal-loan apps whose loans must be repaid in full within 60 days or less**. Store metadata must show minimum/maximum repayment period, maximum APR and a representative total-cost example **[unverified this session — background knowledge; check the live page]**.

**1.4 Apple App Store.** Guideline 3.2.2(ix) historically requires loan apps to disclose all loan terms including maximum APR, to keep **APR at or below 36% including fees**, and to avoid **full repayment in 60 days or less** ([App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)) **[unverified this session]**.

- **However:** Indian App Store listings for CRED show **APR 9.5%–45%** ([CRED App Store](https://apps.apple.com/IN/app/id1428580080)) and Groww shows **13%–48%** ([Groww App Store](https://apple.co/4fbWsoa)).
- So either the 36% cap is not applied in India or the guideline has changed **[interpretation — confirm with Apple before the iOS launch]**.

**1.5 Other rules that shape UX (from background knowledge; confirm with the regulatory research stream).**

- **Device permissions.** DLAs must not access files/media, contacts, call logs or telephony functions. **One-time** access to camera, microphone or location is allowed for onboarding/KYC with explicit consent **[likely — carried from the 2022 guidelines into the 2025 Directions; para not verified]**.
- **Lender identity at onboarding.** The RE's name must be shown upfront at onboarding, and the LSP's grievance redressal officer must be named on the app and website **[likely]**.
- **KFS and cooling-off.** A KFS with APR must be given before execution. A cooling-off/look-up period applies: at least 3 days for loans of 7 days or longer, 1 day for shorter loans **[likely]**.
- **Credit limits.** Automatic credit-limit increases without explicit consent are prohibited **[likely]**.
- **Money flows.** Disbursal and repayment must go directly between the borrower and the RE's account, with no LSP pool account **[likely]**.
- **LSP fees.** LSP fees are paid by the RE, not the borrower **[likely]**.
- **DLG cap.** DLG is capped at 5% of the portfolio **[likely]**.
- **Penal charges, not penal interest**, effective from Jan 2024 **[likely]**.
- **Prepayment.** No prepayment charges on floating-rate loans to individuals sanctioned on or after 1 Jan 2026 (RBI Pre-payment Charges Directions, July 2025) **[unverified]**.
- **Consolidated Master Directions.** RBI's consolidated Master Directions of **28 Nov 2025** may have moved the Digital Lending Directions into RE-category directions **[unverified — defer to the regulatory stream; cite the current instrument name in the final control library]**.

**1.6 Consumer-protection overlay.**

- The CCPA _Guidelines for Prevention and Regulation of Dark Patterns, 2023_ list 13 dark patterns, including false urgency, basket sneaking, confirm-shaming, forced action, interface interference, bait-and-switch, drip pricing, disguised ads and nagging **[unverified this session]**.
- The **DPDP Rules, 2025** (notified Nov 2025, phased in) require itemised, unbundled consent and an easy way to withdraw it **[unverified this session]**.
- RBI's **FREE-AI** framework report (Aug 2025) recommends disclosing to customers when they are dealing with AI and offering human escalation **[unverified this session]**.

### 2. Enforcement and failure lessons

- **ZestMoney (shut Dec 2023).**
  - Its BNPL model depended on non-bank PPI credit lines, which RBI barred in June 2022. The 2022 digital-lending rules and Nov 2023 risk-weight increases followed, and PhonePe dropped its acquisition in March 2023 **[confirmed — secondary]** ([Inc42](https://inc42.com/features/last-days-of-zestmoney-why-indias-bnpl-poster-child-shut-shop/amp/) (Dec 2023); [Kapronasia](https://kapronasia.com/insight/blogs/payments-research/india-payments-research/why-is-zestmoney-shutting-down) (2023)).
  - **Lesson:** do not build on regulatory grey zones such as pass-through funds, unregulated credit lines or FLDG workarounds, and do not chase volume with subsidies.
- **Illegal loan-app crackdown.**
  - MeitY has blocked **87 illegal digital lending apps under s.69A of the IT Act**, per a Lok Sabha reply in **Dec 2025** **[confirmed — secondary]** ([Medianama](https://www.medianama.com/2025/12/223-meity-87-illegal-lending-apps-it-act/) (Dec 2025); [Inc42](https://inc42.com/buzz/87-illegal-lending-apps-blocked-so-far-govt/) (Dec 2025)).
  - The status of the proposed BULA bill (Banning of Unregulated Lending Activities) is **[unverified]**.
  - **Lesson:** the abuses that drove the crackdown were contact scraping, harassment and hidden fees. Trust signals that separate Udofin from those apps are a competitive asset.
- **RE-level actions.** These are background knowledge and **[unverified this session]**:
  - RBI barred **Bajaj Finance's eCOM and Insta EMI Card** lending in **Nov 2023** for not issuing KFS on digital loans, and lifted the bar in 2024.
  - In **Oct 2024** RBI restricted **Navi Finserv, DMI Finance, Asirvad and Arohan** over pricing (usurious APR) and related issues; the restrictions were later lifted.
  - **Lessons:** KFS delivery must be logged as evidence, and APR outliers on the offer screen are a regulatory risk for the partner RE.
- **Google Play removals.** Google took enforcement action on about **3,500 loan apps** in India in 2022 ([Deccan Herald](https://www.deccanherald.com/amp/story/technology%2Fpolicy-violation-google-takes-enforcement-action-on-3500-loan-apps-on-play-store-in-india-1213589.html) (2022)) **[confirmed — secondary]**. The store, not only RBI, controls distribution.

### 3. Competitor profiles (UX-relevant facts)

Evidence tags: **(v)** = verified this session via a search extract of the cited page; **(bk)** = background knowledge, not re-verified **[unverified]**.

**Marketplaces / LSPs**

- **Paisabazaar (PB Fintech).**
  - Offers: "pre-approved offers" from **30+ lenders**, including Tata Capital, Axis, IndusInd, Hero FinCorp, Federal Bank and Aditya Birla Capital, ranked by eligibility (v). Disbursal cash-back promotions run, e.g. "₹1,000 cashback on loan disbursal, valid till 30 Apr '26" (v) ([Paisabazaar](https://www.paisabazaar.com/personal-loan/2-lakh) (2026)).
  - Credit score: a free credit report and score are the acquisition hook (bk). The claim that checking offers does not affect the score rests on one testimonial (v).
  - Transferable patterns: score-led acquisition, eligibility-ranked offers, assisted (call-centre) completion.
  - Risks: incentive-led ranking can conflict with the para 6 "unbiased view"; cash-back nudges may count as steering.
- **BankBazaar.** Comparison marketplace with a free credit score and a mix of assisted and digital journeys (bk). No 2026 data was gathered because the search budget ran out.
- **PhonePe.**
  - Launched a **secured-lending platform on 30 May 2024** covering six categories, including loans against MF, gold, property, vehicles and education. Partners: **Tata Capital, L&T Finance, Hero FinCorp, Muthoot Fincorp, DMI Housing, Home First, rupyy, Volt Money, Gradright** (v) ([PhonePe press](https://www.phonepe.com/press/phonepe-launches-secured-lending-platform-with-marquee-partners/) (May 2024)).
  - Merchant-loan partners: LenDenClub, Aditya Birla Finance, PayU Finance and Muthoot FinCorp (v) ([PhonePe merchant help](https://cms.phonepe.com/en/mx/merchant-help/loans/) (n.d.)).
  - Pattern: secured-first lending inside a UPI app, with **another LSP (Volt) embedded as a partner**. LSP-within-LSP is an established distribution route for Udofin.
- **Google Pay.**
  - Personal loans from **DMI Finance, Aditya Birla Capital, Bajaj Finance, Axis Bank, L&T Finance, SMFG India Credit and IDFC FIRST Bank** (v) ([Google Pay India](https://pay.google.com/intl/en_in/about/) (2026)).
  - Credit lines on UPI with ICICI and HDFC; merchant lending (secondary) ([TechCrunch](https://techcrunch.com/2023/10/18/google-pay-deepens-consumer-and-merchant-lending-offerings-in-india) (Oct 2023)).
  - **"Flex by Google Pay"**, a UPI-linked RuPay co-branded credit card with Axis Bank, launched **Dec 2025** (v) ([TechCrunch](https://techcrunch.com/2025/12/17/google-deepens-consumer-credit-push-in-india-with-upi-linked-card) (Dec 2025)).
  - UX: lender-branded, pre-approved, in-app offers with UPI Autopay repayment (bk).
- **Paytm.** Distributes personal and merchant loans for partner NBFCs and banks. Postpaid was scaled back after the Nov 2023 risk-weight changes; its 2026 status is **[unverified]** (bk).
- **CRED.**
  - Store listing states that **"DTPL acts as a Lending Service Provider (LSP) and the CRED app acts as a Digital Lending App (DLA)"**. Partner lenders listed: IDFC FIRST, Kisetsu Saison, Liquiloans (P2P), Vivriti, DBS and NewTap; L&T Finance joined in Aug 2024 (v) ([CRED App Store](https://apps.apple.com/IN/app/id1428580080) (2026); [Inc42](https://inc42.com/?p=474498) (Aug 2024)).
  - **CRED Cash+ (LAMF)** launched Feb 2025 from 8.99%, "instant liquidity without liquidation", minimum MF portfolio ₹2,000; listing shows APR 9.5%–45% (v) ([The Captable](https://the-captable.com/2025/02/cred-cash-plus-mutual-funds-loans/) (Feb 2025)).
  - Pattern: an explicit LSP/DLA legal-role statement plus a lender list. **Copy this.**
- **Amazon Pay.** Completed the **acquisition of NBFC axio (ex-Capital Float) in early Sept 2025** after RBI approval. axio has about 10 million customers, about ₹2,200 cr AUM, and a checkout-finance and personal-loan book (v) ([The Week/PTI](https://www.theweek.in/wire-updates/business/2025/09/04/dcm122-biz-amazon-axio.html) (4 Sep 2025); [Medianama](https://www.medianama.com/2025/01/223-amazon-fintech-india-axio-acquisition/) (Jan 2025)).
- **Groww.** The DLA serves **IDFC FIRST, Aditya Birla Finance, Kisetsu Saison and Groww Creditserv**. Personal loans run 3–60 months at 13%–48% APR (v) ([Groww App Store](https://apple.co/4fbWsoa) (2026)). **LAMF went live on 6 Oct 2025** (v) ([Groww update](https://groww.in/updates/loan-against-mutual-funds-on-groww-credit) (Oct 2025)).
- **Navi.** An NBFC (Navi Finserv) with its own app, a UPI app and personal/home loans. One of the first credit-line-on-UPI launches, with Karnataka Bank (secondary) ([Analytics Insight](https://www.analyticsinsight.net/finance/sachin-bansals-navi-expands-beyond-lending-into-upi-insurance-investments) (2025)).
- **Volt Money (LAMF LSP).**
  - Fetches the MF portfolio and sends lien requests to **CAMS and KFintech** (MF Central is also mentioned). The borrower confirms by **OTP to the folio-registered mobile**. **Lien marking typically completes in about 10 minutes**, with **9,000+ eligible schemes** (v) ([Volt — lien marking](https://voltmoney.in/blog/lien-marking-mutual-funds) (2026); [Volt — how to](https://voltmoney.in/blog/how-to-take-loan-against-mutual-funds) (2026)).
  - Lender **DSP Finance** confirmed via a distributor page ([Malewar MF](https://www.malewarmutualfunds.com/loan-against-mutual-funds/) (n.d.)); other lenders are **[unverified]**.
  - Volt's own guide warns that **the lien stays after repayment until a release is requested**. That is an **anti-pattern to fix**: auto-prompt lien release when the loan is closed.
  - The **smallcase, Mirae Asset and DSP** in-house LAMF journeys follow the same pattern (portfolio fetch, scheme selection, OTP lien, eSign, credit line) (bk) **[unverified]**.
- **Rupeek.** Gold-loan LSP for bank partners with doorstep or branch valuation (bk). Shows that a physical step can be wrapped in a digital front end.

**NBFC-owned DLAs**

- **Money View.**
  - Journey: PAN and basic details, eligibility in about 2 minutes, a **"KYC selection step"** (choice of methods), selfie, then disbursal (v) ([moneyview.in/llms.txt](https://moneyview.in/llms.txt) (2026)).
  - Scale: **4.76★ from about 4.11 million Play ratings, 100M+ installs** (Quash tracker, 9 Sep 2026) (v) ([Quash](https://quashbugs.com/release-health/moneyview) (Sep 2026)). **14.03 crore registered users at 30 Jun 2026** per an IPO note (v) ([IPO Guru/SMC](https://www.ipoguru.in/review/files/smc-global-moneyview-ipo-guru.pdf) (Jul 2026)).
  - Complaints (Trustpilot, 2025–26): **abusive or threatening collection calls, including over EMIs already paid, and unreachable customer care** (v, anecdotal) ([Trustpilot](https://pt.trustpilot.com/review/moneyview.in) (2026)).
- **KreditBee, Fibe, Kissht, Freo (MoneyTap), mPokket, Bajaj Finserv, Tata Capital, Poonawalla, Lendingkart** (bk) **[unverified]**:
  - Common pattern: mobile OTP, PAN, basic income/employer details, bureau check, provisional offer, Aadhaar OTP or DigiLocker KYC plus selfie liveness, bank statement (net-banking/AA/PDF), eNACH or UPI Autopay, Aadhaar eSign, disbursal.
  - Bajaj Finserv and Tata Capital emphasise pre-approved offers for existing customers.
  - Freo bundles a credit line with a savings account; mPokket targets small-ticket student and young-earner loans; Lendingkart serves MSMEs.
  - Complaint themes for KreditBee (low-quality guide sources only): delayed disbursal, EMI not reflected, KYC failures, undisclosed fees, recovery calls ([Google Groups guide](https://groups.google.com/g/kreditbeecomplaint_com/c/kIosnR_zKqk/m/TX3Fs_VfAgAJ) (Apr 2026), low reliability).

### 4. Feature matrix

| Player                                     | Model              | Key products                                          | Onboarding / KYC                                     | Multi-lender offer and APR display                               | Repayment UX                                | Trust and disclosure                              | Credit score / PFM              | Rating / complaints                               | Evidence         |
| ------------------------------------------ | ------------------ | ----------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------- | ------------------------------- | ------------------------------------------------- | ---------------- |
| Paisabazaar                                | Marketplace LSP    | PL, cards, HL, credit report                          | Mobile OTP, basic details, bureau; KYC at lender     | Ranked list from 30+ lenders, "pre-approved" labels, rate ranges | Lender channels                             | Lender names on offers                            | Free credit report (core hook)  | Cash-back nudges                                  | partial (v)/(bk) |
| BankBazaar                                 | Marketplace LSP    | PL, cards, HL                                         | Similar                                              | Comparison tables                                                | Lender channels                             | Lender names                                      | Free credit score               | —                                                 | (bk)             |
| PhonePe                                    | Super-app LSP      | Secured (MF, gold, LAP, vehicle, edu), merchant loans | Pre-filled from UPI profile                          | Lender-branded offers; Volt embedded                             | UPI-native                                  | Lender list on press/help pages                   | —                               | —                                                 | (v) partners     |
| Google Pay                                 | Super-app LSP      | PL, gold, UPI credit line, Flex card                  | Pre-filled, pre-approved                             | Single or few lender cards                                       | UPI Autopay (bk)                            | Lender list on India page                         | —                               | —                                                 | (v) partners     |
| CRED                                       | LSP (DTPL) + DLA   | PL (Cash), LAMF (Cash+), Flash BNPL                   | Pre-approved for members                             | APR range on listing                                             | In-app / UPI                                | **Explicit LSP/DLA role statement** + lender list | Credit score, card management   | —                                                 | (v)              |
| Groww                                      | DLA + own NBFC     | PL, LAMF (6 Oct 2025)                                 | Investor KYC reused                                  | APR 13–48% on listing                                            | In-app                                      | Lenders named on listing                          | Investments view                | —                                                 | (v)              |
| Amazon Pay                                 | Own NBFC (axio)    | Checkout finance, PL                                  | Amazon account pre-fill                              | Single lender                                                    | Amazon Pay                                  | —                                                 | —                               | —                                                 | (v) deal         |
| Navi                                       | Own NBFC + UPI app | PL, HL, UPI credit line                               | Fully digital                                        | Single lender                                                    | UPI                                         | —                                                 | —                               | —                                                 | secondary        |
| Volt Money                                 | LAMF LSP           | LAMF credit line                                      | PAN + MF fetch; OTP lien via CAMS/KFin (~10 min)     | Lender shown                                                     | Repay to lender; **lien not auto-released** | RE named                                          | Portfolio view                  | —                                                 | (v)              |
| Money View                                 | NBFC + LSP         | PL, credit tracker                                    | PAN + basics, eligibility ~2 min, KYC choice, selfie | Own + partner offers                                             | eNACH / UPI (bk)                            | —                                                 | Credit tracker (bk)             | **4.76★ / 4.1M**; collection-conduct complaints   | (v)              |
| KreditBee / Fibe / Kissht / Freo / mPokket | NBFC DLAs          | Small-ticket PL, credit lines                         | Aadhaar OTP / DigiLocker + selfie                    | Single lender                                                    | eNACH / UPI Autopay                         | Lender name, GRO in app (bk)                      | Some credit-score features (bk) | Recovery and fee complaints (low-quality sources) | (bk)             |
| Bajaj Finserv / Tata Capital / Poonawalla  | Large NBFC apps    | Full range                                            | Pre-approved for existing customers                  | Single lender                                                    | eNACH, pay-now links                        | Strong brand                                      | Bajaj: score + PFM (bk)         | KFS enforcement lesson (Bajaj 2023, bk)           | (bk)             |

### 5. 2025–2026 trends relevant to an LSP

1. **Payments platforms are buying NBFCs.** Amazon/axio (Sept 2025, v), Groww Creditserv (v) and Navi show that the scaled LSPs are vertically integrating. A pure LSP must win on **neutral comparison and journey quality**, not just distribution **[interpretation]**.
2. **Secured and LAMF lending is growing.** PhonePe (May 2024), CRED Cash+ (Feb 2025), Groww LAMF (Oct 2025) and Volt all fit an LSP well:
   - collateral checks are digital (RTA/depository lien by OTP);
   - tenors are long enough for app-store rules;
   - pricing is low and comparable across lenders. **[interpretation]**
3. **ULI (RBIH Unified Lending Interface).** It has moved from pilot to scale.
   - Reported in Jan 2026 as **64 lenders and 136 data services**, citing RBI's _Trend and Progress_ report ([Medianama](https://www.medianama.com/2026/01/223-unified-lending-interface-64-lenders-136-data-services/) (Jan 2026)) **[confirmed — secondary]**.
   - RBIH says **Equifax, CIBIL, CRIF High Mark and Experian are live on ULI**. A **pilot with 6 lenders went live on 1 Mar 2026** for vehicle-hypothecation termination with MoRTH ([RBIH What's New](https://rbihub.in/projects/unified-lending-interface/whats-new) (2026), via extract) **[confirmed — primary via extract]**.
   - Earlier figures: about ₹27,000 cr of loans and 36 REs by 6 Dec 2024 ([Chambers Fintech 2025](https://gpg-pdf.chambers.com/view/203792615/300/)).
   - Integration cost and consent responsibility sit with **lenders** ([IMPRI](https://www.impriindia.com/insights/policy-update/unified-lending-interface-rbis-digital-push-for-faster-credit-access-2025/) (2025)).
   - **Relevance to Udofin:** ULI is **lender-side infrastructure**. No source showed LSPs connecting directly **[interpretation]**. Udofin gains indirectly: partner REs (or Finbyx acting as their technology provider) can pull land records, vehicle/RC, GST and bureau data through ULI for LAP, vehicle and MSME products. That lowers document uploads in Udofin's front end. Design the application data model so RE-side ULI pulls can pre-fill and replace uploads.
4. **Account Aggregator** income verification is now standard practice. RBI reportedly recognised Sahamati as the AA **SRO on 5 Jun 2026** ([ecorpit guide](https://ecorpit.com/account-aggregator-integration-fintech-builders-2026/) (2026)) **[likely — secondary only]**.
   - Purpose code **104** supports consented loan monitoring ([Sahamati](https://sahamati.org.in/loan-monitoring-use-case-for-account-aggregator-framework/)).
   - **The FIU must be a regulated entity.** Udofin, as an unregulated LSP, should run AA consent **under the partner RE's FIU identity**, not its own **[interpretation]**.
5. **Credit on UPI.**
   - Pre-sanctioned credit lines on UPI (RBI, Sept 2023) are limited to **scheduled commercial banks**, extended to **SFBs in Dec 2024** ([Business Standard](https://www.business-standard.com/amp/finance/news/rbi-allows-small-finance-banks-to-offer-pre-sanctioned-credit-line-on-upi-124120600474_1.html) (Dec 2024)).
   - **NBFCs are not yet eligible.** FIDC reportedly asked RBI for access in Sept 2025 ([FinBox research](https://research.finbox.in/blog/credit-line-on-upi-providers-india/) (2025–26)) **[likely]**.
   - NPCI's **31 Aug 2025** guidelines require transactions to be **purpose-tagged** to the sanctioned purpose ([ScoreMe](https://scoreme.in/credit-line-on-upi-decoding-the-latest-rules-on-purpose-tagging-and-risk-operations/)). A further NPCI standardisation deadline of **15 Dec 2026** is reported ([RetailIntel](https://retailintel.in/signal/upi-credit-line-framework-sets-15-december-2026-deadline-for-236f259c)) **[unverified — secondary only]**.
   - Inc42 reports **new RBI directions on credit on UPI** ([Inc42](https://inc42.com/buzz/what-changes-with-rbis-new-directions-on-credit-on-upi/)); their content could not be read **[unverified]**.
   - **Relevance:** Udofin could distribute bank-issued UPI credit lines only through bank partners, not through NBFC partners.
6. **UPI-led onboarding and CKYC 2.0.**
   - UPI is used for bank-account verification (reverse penny-drop) and for **UPI Autopay mandates** (bk; no RBI rule found).
   - **CKYC 2.0** is reported to allow OTP-consented, real-time KYC fetch by mobile or PAN from **1 Aug 2026** ([Digit](https://www.digit.in/news/general/from-upi-privacy-updates-to-ckyc-20-and-itr-filing-these-important-changes-will-be-effective-from-august-1-2026.html) (2026)) **[unverified — secondary only]**. If confirmed, the RE's KYC step after offer selection could shrink to one OTP.
   - UPI had **55.49 crore onboarded users (Jun 2026)** per NPCI as reported in the same search set **[likely]**.
7. **Regulator-driven UX changes.** These include:
   - the para 6 multi-lender digital view (1 Nov 2025);
   - the public DLA list (Jul 2025) and Play's dependence on it;
   - KFS with APR for all retail/MSME loans (bk);
   - penal charges replacing penal interest (bk);
   - the prepayment-charges directions (bk);
   - CCPA dark-pattern guidelines (bk);
   - the DPDP consent model (bk).

### 6. Realistic minimum number of interactions to START an application

Definitions:

- "Start" means reaching a **multi-lender offer screen**, which is when an application exists.
- An **interaction** is a deliberate user action: a tap, a field entry or an OTP entry.

| #                   | Step                                                                                                                              | Interactions                   | Notes                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| 1                   | Enter mobile number and continue                                                                                                  | 1–2                            | Use the Android Phone Number Hint API rather than phone-number permissions       |
| 2                   | Mobile OTP                                                                                                                        | 0–1                            | **SMS Retriever / User Consent API** auto-fill, with no READ_SMS permission (bk) |
| 3                   | Consents: (a) T&C + privacy notice + bureau/eligibility check for named partner REs; (b) **separate, optional** marketing consent | 1–2                            | Must not be pre-ticked or bundled (DPDP / CCPA, bk)                              |
| 4                   | PAN entry; name/DOB auto-filled from PAN verification and confirmed                                                               | 2                              |                                                                                  |
| 5                   | Product, amount and purpose (or MF portfolio fetch for LAMF)                                                                      | 1–2                            |                                                                                  |
| 6                   | Employment type + monthly income (skip for LAMF)                                                                                  | 1–2                            |                                                                                  |
| **Total to offers** |                                                                                                                                   | **≈ 7–9 (absolute floor ≈ 6)** | For LAMF: add MF portfolio fetch by PAN + RTA OTP, about 2 interactions          |

**After offer selection (cannot be removed by regulation):**

| Step                                                             | Interactions |
| ---------------------------------------------------------------- | ------------ |
| Select offer and open KFS                                        | 2            |
| Accept KFS                                                       | 1            |
| RE KYC: DigiLocker/Aadhaar OTP under the RE's KUA, or CKYC fetch | 3–4          |
| Selfie liveness                                                  | 1–2          |
| Bank account (UPI reverse-penny-drop or account entry)           | 1–3          |
| UPI Autopay or eNACH mandate                                     | 2–3          |
| eSign by Aadhaar OTP                                             | 2–3          |
| For LAMF/LAS: lien or pledge OTP                                 | 1–2          |

**Realistic total from download to disbursal: about 20–28 interactions.** Udofin's plan puts Aadhaar OTP, DigiLocker and CKYC _before_ offers, adding about 8 interactions before the borrower sees any value. That conflicts with how REs must own KYC (see Challenges) **[interpretation / recommendation]**.

### 7. UX patterns to copy

1. **Legal-role banner** in the style of CRED: "Udofin Technologies [legal name] is a Lending Service Provider. Loans are given by [RE list]." Show it on the splash/onboarding screen, the store listing and every offer **[pattern verified on CRED listing]**.
2. **Lender-branded offer cards** (as on Google Pay/PhonePe) with RE logo and legal name, "Regulated by RBI", and a link to the RE's entry on RBI's DLA list.
3. **Eligibility before KYC** (Money View, Paisabazaar): PAN plus basic details produce offers in about 2 minutes; KYC follows.
4. **KYC method choice** (Money View's "KYC selection step"): DigiLocker, Aadhaar OTP, CKYC, with V-CIP as fallback for high-value or exception cases.
5. **LAMF portfolio-fetch and OTP lien** (Volt, CRED Cash+, Groww), plus **auto-prompted lien release on closure**, which fixes Volt's gap.
6. **A para 6–compliant comparison table**:
   - a default **neutral sort** (lowest APR, then lowest EMI) with the sort rule disclosed;
   - user-selectable sort options;
   - an "Other lenders checked: X, Y — no offer" row;
   - a **KFS link per offer**;
   - **no "recommended" badges**.
7. **Repayment hub**:
   - UPI Autopay as the default, eNACH as fallback;
   - one-tap pay-now UPI intent/collect link for overdue or part-payments, paying into the RE's collection account;
   - a full statement of account and foreclosure quote;
   - NOC download.
8. **Trust page** linked from the footer of every screen:
   - Udofin's grievance officer (name, email, phone);
   - each RE's nodal officer;
   - escalation to RB-IOS/CMS after 30 days;
   - recovery-agent list;
   - DLA-list links.
9. **Reminder cadence** limited to service messages (T-3, T-1, due day). Marketing notifications follow a separate opt-in.
10. **AI assistant** with a visible "AI" label. It answers from KFS, statements and FAQs only, makes no credit decisions, and has a one-tap human handover plus a "raise a complaint" button that creates a ticket with an ID and SLA.

### 8. Anti-patterns (dark patterns) to avoid

- **Steering:** "Best for you" or sponsored ranking driven by commission, which breaches para 6; hiding unmatched lenders.
- **Bait and switch:** "Pre-approved ₹5 lakh!" banners that resolve to smaller or costlier offers.
- **Drip pricing:** showing rate per month or headline interest without APR; insurance or processing fees appearing at the KFS stage.
- **Basket sneaking:** pre-selected credit insurance or "membership" add-ons.
- **False urgency:** "offer expires in 10 min" timers; cash-back expiring to rush acceptance (Paisabazaar-style disbursal cash-back needs care).
- **Forced action:** requiring contacts, location, SMS or storage access, or forcing marketing consent, as a condition to proceed. Illegal-app history and Play policy apply.
- **Confirm-shaming** on declining an offer or withdrawing consent; **nagging** push notifications.
- **"Won't affect your score"** claims when a hard pull is made.
- **Automatic limit increases**, and auto-renewal of credit lines without explicit consent.
- **Lien left in place after repayment** (Volt's documented gap).
- **Collection harassment:** the most consistent complaint in Money View's 2025–26 reviews.
- **Unreachable support.**

### 9. Recommended MVP vs later phases

| Phase                     | Features                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MVP (0–6 months)**      | Android app + responsive web. Products: **LAMF/LAS** (CAMS/KFin lien; NSDL/CDSL pledge via the RE's or depository participant's pledge flow) and **unsecured personal loans** from 2–4 REs. Phone-number hint + SMS Retriever OTP. Unbundled DPDP consents. PAN verification, then a **para 6 multi-lender view** with per-offer KFS link and unmatched-lender list. RE-performed KYC via DigiLocker/Aadhaar OTP/CKYC under the RE's KUA, plus selfie liveness with one-time camera use. AA bank-statement consent **under the RE's FIU**. UPI Autopay/eNACH **in the RE's name**. Aadhaar eSign (RE as ASP or through its provider); eStamp per RE. Repayment hub with pay-now links to the RE's account. Statement/NOC. Trust page (GRO, RE nodal officers, RB-IOS, DLA-list links). Service notifications. Ticketing with SLA. FAQ-bound AI assistant with human handover. Audit log of offers shown, sort rule, KFS delivered and consents. |
| **Phase 2 (6–12 months)** | iOS (after Apple APR/tenor review). Gold loans (via RE partner). Vehicle loans. CKYC 2.0 one-OTP KYC. Bureau-score display through a consumer-initiated bureau product. Marketing notifications with separate opt-in. V-CIP fallback. Multilingual UI. Collections module as a **disclosed recovery agent** (only if contracted and named in the KFS).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Phase 3 (12+ months)**  | LAP and home loans with assisted/physical steps; ULI-backed data pre-fill on the RE side. Credit line on UPI (bank partners only). AA-based PFM view (only under a regulated FIU or once Udofin holds a licence). Optional post-dispute ODR referral (if legally cleared). Debt-reset refinancing (needs careful suitability and fair-practice design).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Do not launch**         | PAYDAY loans repayable in full within 60 days or less (Play/Apple rules). SMS-scraping "books of accounts". PayPal/Stripe for domestic loan repayments.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

---

## Requirements-to-controls

| ID    | Requirement                                                                                                                                        | Source (instrument + para/section if verified)                                                           | Applies to                    | Status                                          | System control in Udofin                                                                                             | Evidence to retain                                                                     | Test case                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| UX-01 | Show all matching offers in an unbiased digital view with RE name, amount, tenor, APR, EMI, penal charges and KFS link; disclose unmatched lenders | RBI (Digital Lending) Directions 2025, **para 6** (secondary-verified), effective 1 Nov 2025             | RE (ensure) / LSP (implement) | confirmed (secondary)                           | Offer engine returns every RE response, including "no offer"; mandatory fields enforced by schema; per-offer KFS URL | Snapshot of the offer screen per application (JSON + render hash), list of REs queried | Query 4 REs, 2 decline: all 4 named; 2 offer cards show all mandatory fields; KFS links resolve |
| UX-02 | Consistent, documented matching logic; no steering or dark patterns                                                                                | RBI DL Directions 2025, para 6 (secondary)                                                               | RE / LSP                      | confirmed (secondary)                           | Versioned ranking-rule config; default sort disclosed; no "recommended" badges; change log with approver             | Rule version per application; change-approval records                                  | Same inputs produce the same ordering; changing commission data does not change order           |
| UX-03 | DLA on RBI public DLA list via each RE's CIMS reporting                                                                                            | RBI press release (2025) on CIMS/DLA list                                                                | RE / LSP                      | confirmed                                       | Pre-launch gate: app go-live per RE blocked until the RE's CIMS entry is verified on RBI list                        | Screenshot/URL of RBI list entry per RE, dated                                         | Remove an RE from the list in staging: its offers are suppressed                                |
| UX-04 | Play: on RBI DLA list; Personal Loan App Declaration; partner REs named in store description                                                       | Google Play Financial Services policy (India section)                                                    | Platform / LSP                | confirmed (extract) / likely (description rule) | Store-listing checklist; partner list synced from contract registry                                                  | Declaration submission, store-listing versions                                         | Store listing lists every live RE; mismatch alert                                               |
| UX-05 | No access to contacts, photos/media, external storage, precise location, call logs, phone numbers                                                  | Google Play Personal Loans policy (since 31 May 2023); RBI DL rules on device access (para not verified) | Platform / LSP / RE           | confirmed (secondary) / likely                  | Manifest lint in CI blocks forbidden permissions; photo picker for uploads; SMS Retriever API for OTP                | CI reports per build; merged manifest                                                  | Build fails if READ_CONTACTS, ACCESS_FINE_LOCATION, READ_SMS or READ_MEDIA_* is present         |
| UX-06 | One-time camera/location for KYC only, with explicit consent                                                                                       | RBI DL rules (likely; para not verified)                                                                 | RE / LSP                      | likely                                          | Runtime prompt at KYC step only; coarse location only if the RE needs it; consent record                             | Consent log with timestamp and purpose                                                 | Deny camera: DigiLocker-only path still completes                                               |
| UX-07 | KFS with APR before execution; cooling-off period shown                                                                                            | RBI KFS / DL rules (para not verified)                                                                   | RE (issue) / LSP (display)    | likely                                          | KFS rendered from the RE's API, acknowledgement required, cooling-off countdown in loan hub                          | KFS PDF hash, view and accept timestamps                                               | eSign blocked until KFS accepted; exit within cooling-off computes correctly                    |
| UX-08 | RE name shown at onboarding; LSP grievance officer details on app/web                                                                              | RBI DL rules (likely)                                                                                    | RE / LSP                      | likely                                          | Static trust page + per-offer RE identity; GRO details from config                                                   | Page versions                                                                          | Trust page reachable in ≤2 taps from any screen                                                 |
| UX-09 | Repayment directly to the RE's account; mandate in the RE's name                                                                                   | RBI DL rules (likely)                                                                                    | RE / LSP / PA                 | likely                                          | UPI Autopay/eNACH set up via the RE's sponsor bank/PA; pay-now links pay to the RE's VPA                             | Mandate IDs, beneficiary account per loan                                              | Pay-now resolves to the RE's account, never a Udofin account                                    |
| UX-10 | No automatic credit-limit increase without explicit consent                                                                                        | RBI DL rules (likely)                                                                                    | RE / LSP                      | likely                                          | Limit change needs a fresh explicit consent screen                                                                   | Consent record                                                                         | API limit increase without consent is rejected                                                  |
| UX-11 | Marketing consent separate; easy withdrawal                                                                                                        | DPDP Act 2023 / Rules 2025 (unverified this session)                                                     | LSP                           | likely                                          | Separate toggles; "withdraw consent" in settings                                                                     | Consent ledger                                                                         | Toggle off stops campaigns within SLA                                                           |
| UX-12 | Avoid listed dark patterns                                                                                                                         | CCPA Dark Patterns Guidelines 2023 (unverified this session)                                             | LSP                           | likely                                          | UX review checklist in release gate                                                                                  | Signed checklists                                                                      | Audit: no timers, no pre-ticked boxes, no add-on preselection                                   |
| UX-13 | AI chat disclosed as AI, human escalation, no credit decisioning                                                                                   | RBI FREE-AI report (Aug 2025, unverified) — recommendation                                               | LSP                           | recommendation                                  | "AI" label; restricted retrieval scope; handover button; complaint creation                                          | Transcripts, escalation logs                                                           | Ask "approve my loan": refused and routed; "human" request reaches an agent                     |
| UX-14 | AA data pulled only by a regulated FIU                                                                                                             | RBI NBFC-AA framework (interpretation)                                                                   | RE / LSP                      | interpretation                                  | AA consent under the RE's FIU ID; Udofin as technology provider                                                      | Consent artefacts                                                                      | No AA call under a Udofin-only ID                                                               |
| UX-15 | No loans repayable in full in ≤60 days in a store-distributed app; iOS APR rule check                                                              | Google Play policy (bk); Apple 3.2.2(ix) (bk)                                                            | Platform / LSP                | unverified                                      | Product config blocks tenor ≤60 days for app channels                                                                | Product-config history                                                                 | Creating a 30-day product fails validation                                                      |

---

## Challenges to the owner's plan

1. **Front-loading Aadhaar OTP, DigiLocker and CKYC before offers.**
   - _Problem:_ KYC is the RE's obligation. Aadhaar e-KYC needs an authorised KUA (the RE or its arrangement). Before a lender is chosen, there is no RE to whom the KYC belongs. It also adds about 8 interactions before the user sees value.
   - _Authority:_ RBI KYC Master Direction / PMLA / Aadhaar Act (**[interpretation — confirm in the legal stream]**); competitor practice (Money View, Paisabazaar).
   - _Alternative:_ PAN + basics → offers → **RE-specific KYC** after selection, using CKYC/DigiLocker under the RE's KUA.
2. **CIBIL "soft pull by Udofin".**
   - _Problem:_ LSPs are not CIC members or specified users. RBI rules limit the personal data an LSP may store. "Soft pull won't affect your score" must be true.
   - _Authority:_ CICRA 2005; RBI DL data-storage limits (**[likely]**).
   - _Alternative:_ either each RE pulls the bureau report for its own offer (multi-RE soft-inquiry orchestration), or a consumer-initiated bureau product shows the score. Udofin should store only minimal data.
3. **Location and OTP-reading permissions; camera scanning of KYC documents.**
   - _Problem:_ Play bars precise location, storage and photos for loan apps. READ_SMS is restricted. RBI bars telephony access.
   - _Alternative:_ SMS Retriever API, one-time camera for selfie liveness, DigiLocker instead of document scans, and coarse location only if an RE requires it.
4. **"Books of accounts" / expense view.**
   - _Problem:_ building it would need SMS or bank-data scraping, which is barred. AA data needs a regulated FIU.
   - _Alternative:_ MVP shows a **loan ledger** (Udofin loans, statements, dues). A PFM view comes later, only via a regulated FIU partner or a licence.
5. **Marketing push notifications.**
   - _Problem:_ marketing needs separate DPDP consent, and on Android 13+ a runtime notification permission. TRAI/DLT rules apply to SMS and calls. Nagging and false urgency are dark patterns.
   - _Alternative:_ service notifications by default; marketing only by separate opt-in, with frequency caps.
6. **AI agent answering borrower queries.**
   - _Problem:_ there is a risk of mis-selling, wrong figures, or the agent being treated as the grievance officer.
   - _Alternative:_ answers limited to KFS and statement data, disclosed as AI, with human escalation, and complaints logged in the formal GRO system with SLA.
7. **Escalation to Equator (same group).**
   - _Problem:_ the formal path is the RE's grievance system, then RB-IOS. Same-group ADR has a conflict of interest, and pre-dispute mandatory arbitration in consumer loans is open to legal challenge **[interpretation]**.
   - _Alternative:_ display GRO, RE nodal officer and RB-IOS prominently. Offer Equator only as an **optional, post-dispute** route with an independence disclosure.
8. **PAYDAY loans.**
   - _Problem:_ Play bars personal loans repayable in full within 60 days or less; Apple has a similar rule plus an APR guideline. RBI has acted against usurious pricing (Oct 2024). The ZestMoney lesson is not to depend on fragile models.
   - _Alternative:_ drop payday loans. If short-tenor credit is required, use 3–12 month EMI products with APR outlier review.
9. **Razorpay, Stripe and PayPal "for all products".**
   - _Problem:_ repayments must flow to the RE. PayPal does not process domestic India payments (bk, since 2021). Stripe's India onboarding is restricted **[unverified]**. Neither supports UPI Autopay or eNACH in the RE's name.
   - _Alternative:_ use the RE's sponsor bank / PA (e.g. Razorpay or Cashfree with the RE as merchant) for UPI Autopay/eNACH. No Udofin pool account.
10. **"5% FLDG, therefore Udofin handles collections".**
    - _Problem:_ a DLG does not by itself give collection rights. Udofin must be appointed as a recovery agent, named in the KFS, and follow conduct rules. Collection harassment is the top complaint in the category.
    - _Alternative:_ a separate recovery-agent contract, a conduct-compliant collections UX (call windows, scripts, recording), and borrower notice before contact.
11. **Too many products at launch.**
    - _Problem:_ home, LAP and vehicle loans need physical verification and property/RC checks. Resolution, legal and medical finance need bespoke credit policy.
    - _Alternative:_ a secured-first MVP (LAMF/LAS) plus personal loans; then gold and vehicle; LAP and home loans once ULI-backed data access is available on the RE side.
12. **eSign + eStamp "in Udofin".** Hosting the step in Udofin's UI is acceptable. The agreement and KFS must be the RE's documents, and eSign must run under the RE's arrangement **[interpretation]**.

## Open questions

1. Current home and para numbers for the multi-lender rule after the 28 Nov 2025 consolidated Master Directions, and any amendments up to 31 Jul 2026.
2. Can partner REs run parallel bureau soft inquiries for a marketplace without a hard-inquiry footprint, and what consent wording do the bureaus require?
3. Apple's 36% APR / 60-day rule as applied to India; Google's current India text on the 60-day rule and lender-name disclosure.
4. Whether RBI has allowed NBFCs to offer credit lines on UPI, and the content of the reported new RBI directions on credit on UPI.
5. Whether CKYC 2.0 is live (1 Aug 2026), and whether REs may treat an OTP-consented CKYC fetch as complete KYC for digital loans.
6. Whether Udofin, as an LSP, can be a technology provider to REs on ULI, or should do so through Finbyx.
7. The ranking default for the para 6 view: lowest APR, or lowest total cost? A board/RE policy decision.
8. Business decision: is collections a revenue line, or delegated to the RE's agencies? Reputational risk is high.
9. Legal review of the Equator referral design, including same-group neutrality.

## Self-verification

| #   | Claim                                                                            | Verdict                                                      | Note                                |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------- |
| 1   | Para 6 multi-lender rule effective 1 Nov 2025                                    | confirmed (secondary, ≥3 sources); primary not fetchable     | Kept                                |
| 2   | Para 6 fields include APR, EMI, penal charges, KFS link; unmatched lenders named | confirmed (secondary; minor wording variance)                | Per-offer KFS link recommended      |
| 3   | RBI public DLA list by 1 Jul 2025; CIMS reporting dates 13 May / 15 Jun 2025     | confirmed (RBI press release via extract)                    | Kept                                |
| 4   | Google Play requires inclusion on RBI DLA list                                   | confirmed (Google help page via extract)                     | Kept                                |
| 5   | Play bars contacts/photos/precise location/call logs since 31 May 2023           | confirmed (secondary, 2023)                                  | Current page not fetchable; flagged |
| 6   | Apple 36% APR / 60-day rule                                                      | could not verify; CRED/Groww listings show APR up to 45%/48% | Marked unverified; open question    |
| 7   | ULI 64 lenders / 136 data services; bureaus live; 1 Mar 2026 pilot               | confirmed (Medianama secondary + RBIH extract)               | Kept                                |
| 8   | Amazon completed axio acquisition Sept 2025                                      | confirmed (PTI/The Week)                                     | Kept                                |
| 9   | Groww LAMF live 6 Oct 2025                                                       | confirmed (Groww update via extract)                         | Kept                                |
| 10  | Money View 4.76★ / ~4.11M ratings; 14.03 crore users at 30 Jun 2026              | confirmed (Quash tracker; IPO note) — third-party            | Kept, labelled third-party          |
| 11  | MeitY blocked 87 illegal lending apps (Dec 2025)                                 | confirmed (secondary, two outlets)                           | Kept                                |
| 12  | Sahamati recognised as AA SRO on 5 Jun 2026; CKYC 2.0 from 1 Aug 2026            | could not verify against primary                             | Marked likely/unverified            |

## Sources

| Title                                                | URL                                                                                                                                                        | Date     | Type                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------ |
| RBI circular index — Digital Lending Directions 2025 | https://www.rbi.org.in/Scripts/BS_CircularIndexDisplay.aspx?Id=12848                                                                                       | 2025     | primary (not fetchable)  |
| RBI press release — DLA reporting / public list      | https://rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=60403                                                                                          | 2025     | primary (extract)        |
| Google Play — Financial Services policy              | https://support.google.com/googleplay/android-developer/answer/9876821?hl=en                                                                               | current  | primary (extract)        |
| Apple App Store Review Guidelines                    | https://developer.apple.com/app-store/review/guidelines/                                                                                                   | current  | primary (not fetched)    |
| RBIH — ULI What's New                                | https://rbihub.in/projects/unified-lending-interface/whats-new                                                                                             | 2026     | primary (extract)        |
| PhonePe — secured lending press release              | https://www.phonepe.com/press/phonepe-launches-secured-lending-platform-with-marquee-partners/                                                             | May 2024 | primary                  |
| PhonePe merchant help — loans                        | https://cms.phonepe.com/en/mx/merchant-help/loans/                                                                                                         | n.d.     | primary                  |
| Google Pay India about page                          | https://pay.google.com/intl/en_in/about/                                                                                                                   | 2026     | primary                  |
| Groww — LAMF product update                          | https://groww.in/updates/loan-against-mutual-funds-on-groww-credit                                                                                         | Oct 2025 | primary                  |
| Groww App Store listing                              | https://apple.co/4fbWsoa                                                                                                                                   | 2026     | primary                  |
| CRED App Store listing                               | https://apps.apple.com/IN/app/id1428580080                                                                                                                 | 2026     | primary                  |
| Volt Money — lien marking                            | https://voltmoney.in/blog/lien-marking-mutual-funds                                                                                                        | 2026     | primary (vendor)         |
| Volt Money — how to take LAMF                        | https://voltmoney.in/blog/how-to-take-loan-against-mutual-funds                                                                                            | 2026     | primary (vendor)         |
| Money View llms.txt                                  | https://moneyview.in/llms.txt                                                                                                                              | 2026     | primary (vendor)         |
| Paisabazaar — personal loan page                     | https://www.paisabazaar.com/personal-loan/2-lakh                                                                                                           | 2026     | primary (vendor)         |
| Sahamati — loan monitoring use case                  | https://sahamati.org.in/loan-monitoring-use-case-for-account-aggregator-framework/                                                                         | n.d.     | primary (SRO)            |
| Saraf & Partners — DL Directions 2025                | https://sarafpartners.com/rbi-notifies-the-rbi-digital-lending-directions-2025/                                                                            | 2025     | secondary                |
| Mondaq — DL Directions 2025                          | https://www.mondaq.com/india/financial-services/1651878/rbi-digital-lending-directions-2025-same-same-but-different                                        | 2025     | secondary                |
| Legal500 — DL Directions 2025                        | https://www.legal500.com/developments/thinked-leadership/the-rbis-digital-lending-directions-2025-a-unified-code-for-a-fragmented-sector/                  | 2025     | secondary                |
| Hammurabi & Solomon — DL Directions 2025             | https://www.hammurabisolomon.in/post/reserve-bank-of-india-digital-lending-directions-2025-brief-overview-analysis                                         | 2025     | secondary                |
| Leegality — DL Directions 2025 KFS                   | https://www.leegality.com/blog/digital-lending-directions-2025                                                                                             | 2025     | secondary                |
| Legistify — DL Directions CLM guide                  | https://legistify.com/blogs/rbi-digital-lending-directions-clm-guide-for-lenders/                                                                          | 2025–26  | secondary                |
| Medianama — RBI DLA directory                        | https://www.medianama.com/2025/05/223-rbi-digital-lending-apps-centralised-directory/                                                                      | May 2025 | secondary                |
| TechCrunch — Google personal-loan app update         | https://techcrunch.com/2023/04/05/google-personal-loan-apps-update/                                                                                        | Apr 2023 | secondary                |
| Business Today — Play restrictions from 31 May 2023  | https://www.businesstoday.in/tech-today/trending/story/google-to-restrict-personal-loan-apps-from-play-store-starting-today-383608-2023-05-31              | May 2023 | secondary                |
| Deccan Herald — Google India loan app policy         | https://www.deccanherald.com/amp/story/technology%2Fgoogle-revises-personal-loan-apps-policy-in-india-blocks-access-to-photos-contacts-1207306.html        | 2022/23  | secondary                |
| Deccan Herald — 3,500 loan apps actioned             | https://www.deccanherald.com/amp/story/technology%2Fpolicy-violation-google-takes-enforcement-action-on-3500-loan-apps-on-play-store-in-india-1213589.html | 2023     | secondary                |
| Medianama — ULI 64 lenders                           | https://www.medianama.com/2026/01/223-unified-lending-interface-64-lenders-136-data-services/                                                              | Jan 2026 | secondary                |
| IMPRI — ULI explainer                                | https://www.impriindia.com/insights/policy-update/unified-lending-interface-rbis-digital-push-for-faster-credit-access-2025/                               | 2025     | secondary                |
| Chambers Fintech 2025 (India)                        | https://gpg-pdf.chambers.com/view/203792615/300/                                                                                                           | 2025     | secondary                |
| Inc42 — ZestMoney                                    | https://inc42.com/features/last-days-of-zestmoney-why-indias-bnpl-poster-child-shut-shop/amp/                                                              | Dec 2023 | secondary                |
| Kapronasia — ZestMoney                               | https://kapronasia.com/insight/blogs/payments-research/india-payments-research/why-is-zestmoney-shutting-down                                              | 2023     | secondary                |
| Medianama — MeitY blocks 87 apps                     | https://www.medianama.com/2025/12/223-meity-87-illegal-lending-apps-it-act/                                                                                | Dec 2025 | secondary                |
| Inc42 — 87 apps blocked                              | https://inc42.com/buzz/87-illegal-lending-apps-blocked-so-far-govt/                                                                                        | Dec 2025 | secondary                |
| Business Standard — SFBs credit line on UPI          | https://www.business-standard.com/amp/finance/news/rbi-allows-small-finance-banks-to-offer-pre-sanctioned-credit-line-on-upi-124120600474_1.html           | Dec 2024 | secondary                |
| FinBox — credit line on UPI providers                | https://research.finbox.in/blog/credit-line-on-upi-providers-india/                                                                                        | 2025–26  | secondary                |
| ScoreMe — NPCI 31 Aug 2025 guidelines                | https://scoreme.in/credit-line-on-upi-decoding-the-latest-rules-on-purpose-tagging-and-risk-operations/                                                    | 2025     | secondary                |
| RetailIntel — 15 Dec 2026 deadline                   | https://retailintel.in/signal/upi-credit-line-framework-sets-15-december-2026-deadline-for-236f259c                                                        | 2026     | secondary                |
| Inc42 — RBI directions on credit on UPI              | https://inc42.com/buzz/what-changes-with-rbis-new-directions-on-credit-on-upi/                                                                             | 2026?    | secondary (not read)     |
| ecorpit — AA integration 2026                        | https://ecorpit.com/account-aggregator-integration-fintech-builders-2026/                                                                                  | 2026     | secondary                |
| Digit — CKYC 2.0 from 1 Aug 2026                     | https://www.digit.in/news/general/from-upi-privacy-updates-to-ckyc-20-and-itr-filing-these-important-changes-will-be-effective-from-august-1-2026.html     | 2026     | secondary                |
| TechCrunch — Google Pay Flex card                    | https://techcrunch.com/2025/12/17/google-deepens-consumer-credit-push-in-india-with-upi-linked-card                                                        | Dec 2025 | secondary                |
| TechCrunch — Google Pay lending                      | https://techcrunch.com/2023/10/18/google-pay-deepens-consumer-and-merchant-lending-offerings-in-india                                                      | Oct 2023 | secondary                |
| The Captable — CRED Cash+                            | https://the-captable.com/2025/02/cred-cash-plus-mutual-funds-loans/                                                                                        | Feb 2025 | secondary                |
| Inc42 — CRED & L&T Finance                           | https://inc42.com/?p=474498                                                                                                                                | Aug 2024 | secondary                |
| The Week/PTI — Amazon completes axio                 | https://www.theweek.in/wire-updates/business/2025/09/04/dcm122-biz-amazon-axio.html                                                                        | Sep 2025 | secondary                |
| Medianama — Amazon–axio                              | https://www.medianama.com/2025/01/223-amazon-fintech-india-axio-acquisition/                                                                               | Jan 2025 | secondary                |
| Analytics Insight — Navi                             | https://www.analyticsinsight.net/finance/sachin-bansals-navi-expands-beyond-lending-into-upi-insurance-investments                                         | 2025     | secondary                |
| Malewar MF — Volt/DSP Finance                        | https://www.malewarmutualfunds.com/loan-against-mutual-funds/                                                                                              | n.d.     | secondary (distributor)  |
| Quash — Money View release health                    | https://quashbugs.com/release-health/moneyview                                                                                                             | Sep 2026 | secondary (tracker)      |
| Trustpilot — Money View                              | https://pt.trustpilot.com/review/moneyview.in                                                                                                              | 2026     | secondary (user reviews) |
| IPO Guru/SMC — Money View IPO note                   | https://www.ipoguru.in/review/files/smc-global-moneyview-ipo-guru.pdf                                                                                      | Jul 2026 | secondary                |
| KreditBee complaint guide (low reliability)          | https://groups.google.com/g/kreditbeecomplaint_com/c/kIosnR_zKqk/m/TX3Fs_VfAgAJ                                                                            | Apr 2026 | secondary (low quality)  |
