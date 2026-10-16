# Primary-source extract: RBI NBFC Income Recognition, Asset Classification and Provisioning Directions, 2025 (updated to 13 February 2026)

- **Instrument:** Reserve Bank of India (Non-Banking Financial Companies – Income Recognition, Asset Classification and Provisioning) Directions, 2025 ("IRACP Directions"), as updated to 13 February 2026
- **Reference:** RBI/DOR/2025-26/356, DOR.STR.REC.No.275/21.04.048/2025-26, 28 November 2025 (signed Vaibhav Chaturvedi, CGM). Paras 36A-36C were inserted with effect from 13 February 2026 by the IRACP Amendment Directions, 2026 (footnote 1 of the text).
- **Source file:** `docs/regulatory/sources/rbi-nbfc-income-recognition-asset-classification-provisioning-directions-2025-updated-2026-02-13.pdf` (22 pages)
- **Method:** Read in full (pages 1-22, paras 1-64) from the PDF text layer (pdftotext, layout mode). The text layer was clean. The page images of page 10 (provisioning table for doubtful assets) were inspected and match the text. Paragraph numbers are as printed. No paragraph was unreadable. The instrument has no tables other than those quoted below (project finance rates at para 30(1), doubtful ageing at para 32(2)(ii), hire-purchase overdue at para 33(3), NBFC-UL standard-asset rates at para 58, NPA glide path at para 44).
- **Status label for everything quoted here:** confirmed (primary text). Statements about what Udofin "must provide" or what the data model needs are our reading (interpretation) unless stated, and need counsel review (section 8).

Important framing: these Directions bind the **NBFC (the lender)**, not Udofin. Udofin is affected only because the lender's servicing, reporting and DLG contract must supply the numbers and dates the lender needs. The text never uses the words "Lending Service Provider", "LSP", "digital loan", "unsecured", "personal loan" or "short tenor". The only DLG content is paras 36A-36C. Several rules the matrix and the DLG design lean on (SMA bands by day count, the 120-day DLG invocation limit, "NPA recognition continues regardless of DLG", restructuring detail) are **not in this text** (section 7).

---

## 1. Applicability

### 1.1 Which lenders

- Para 3: applies to NBFC-D, NBFC-ICC, NBFC-Factor, NBFC-IFC and IDF-NBFC.
- Para 4: applies to HFCs unless inconsistent with the RBI (Housing Finance Company) Directions, 2025, which prevail.
- Para 5: applies to NBFC-MFI unless inconsistent with the MFI Directions, 2025, which prevail. The classification paras 21-27 (para 20) and the NPA provisioning paras 29 and 32 exclude "the microfinance loan portfolio of a NBFC-MFI".
- Paras 6, 7: Mortgage Guarantee Companies and Core Investment Companies, unless their own Directions conflict.
- Para 10 (not applicable): "(1) NBFC-P2P ... (2) NBFC-AA ... (3) SPD ... (4) NOFHC ... (5) 'NBFC not availing public funds and not having any customer interface'; (6) 'NBFCs-BL having customer interface but not availing public funds'."
- Para 8: an Ind AS NBFC "shall continue to be guided by the Standards and the advisories issued by the ... ICAI ... in case of any inconsistencies between these Directions and the Standards."
- Para 9: restructured accounts are governed "in addition" by the RBI (NBFC - Resolution of Stressed Assets) Directions, 2025. **That instrument is not in our sources folder.**

### 1.2 Layer structure (what applies to which lender)

| Chapter           | Applies to           | Content                                                                                                                                        |
| ----------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| II (paras 15-41)  | All NBFCs            | Loan agreement content, day-end process, SMA/NPA dating, upgrade rules, provisioning mechanics, DLG provisioning (36A-36C), income recognition |
| III (paras 42-49) | NBFC-BL (additional) | NPA = more than 180 days overdue, with a glide path to 90 days (para 44); sub-standard up to 18 months; standard-asset provision 0.25%         |
| IV (paras 50-55)  | NBFC-ML (additional) | NPA = more than 90 days overdue; sub-standard up to 12 months; standard-asset provision 0.40%                                                  |
| V (paras 56-60)   | NBFC-UL              | Para 56 applies Chapter IV paras 50-53 "mutatis mutandis"; standard-asset rates at para 58                                                     |

**Consequence:** each partner lender's layer must be a lender-level configuration (BL / ML / UL). See 8.1 for the BL anomaly.

---

## 2. Definitions and the day-end rules (the heart of the DPD model)

### 2.1 Quoted definitions (para 11)

- Para 11(2): "'overdue' status – any amount due to a NBFC under any credit facility shall be treated as 'overdue' if it is not paid on the due date fixed by the NBFC."
- Para 11(3): "'standard asset' shall mean the asset in respect of which, no default in repayment of principal or payment of interest is perceived and which does not disclose any problem or carry more than normal risk attached to the business."
- Para 11(1): "'loss asset'" means (i) an asset identified as loss asset by the NBFC, its auditor or RBI, to the extent not written off; or (ii) an asset "adversely affected by a potential threat of non-recoverability due to either erosion in the value of security or non-availability of security or due to any fraudulent act or omission on the part of the borrower".
- The text contains **no definition of SMA-0, SMA-1 or SMA-2 as day bands**. SMA appears only in para 15(1), para 17(1), para 19 and Illustration I (below).

### 2.2 Day-end process (paras 18-19), quoted

- Para 18: "An NBFC shall flag a borrower account as overdue, if so, as part of their day-end processes for the due date, irrespective of the time of running such processes."
- Para 19: "classification of borrower accounts as SMA as well as NPA shall be done as part of day-end process for the relevant date and the SMA or NPA classification date shall be the calendar date for which the day end process is run. Thus, the date of SMA / NPA shall reflect the asset classification status of an account at the day-end of that calendar date."

### 2.3 Illustration I (para 19), the only worked example of SMA dating

- Due date 31 March 2021, full dues not received before day-end: "the date of overdue shall be March 31, 2021."
- "SMA-1 upon running day-end process on April 30, 2021 i.e. upon completion of 30 days of being continuously overdue" (SMA-1 date = 30 April 2021).
- SMA-2 "upon running day-end process on May 30, 2021".
- NPA "upon running day-end process on June 29, 2021."

Arithmetic we derive (interpretation, from the illustration): counting the due date itself as day 1 of overdue, SMA-1 falls on day 31, SMA-2 on day 61 and NPA on day 91, i.e. classification date = due date + 30, + 60, + 90 calendar days. This reconciles the illustration with the NPA test "overdue for a period of more than 90 days" (para 51). The text does not itself state SMA-1 as "31-60 days" or SMA-0 as "1-30 days"; those band labels come from older RBI circulars that this instrument does not reproduce (status: unverified in this text).

### 2.4 Overdue is measured from the lender's due date, with no grace

Para 11(2) and para 18 make a missed due date overdue at that day's day-end. The text provides **no grace period**. "Overdue" starts on the due date fixed by the NBFC, whatever Udofin's internal reminder policy.

---

## 3. Asset classification

### 3.1 Classes and borrower-level classification

- Para 21: classes are "(i) Standard assets; (ii) Sub-standard assets; (iii) Doubtful assets; and (iv) Loss assets", also following the Resolution of Stressed Assets Directions for stressed cases.
- Para 23: "Asset classification shall be borrower-wise and not facility-wise. All the facilities granted by an NBFC to a borrower ... shall have to be treated as NPA / Non-Performing Investment (NPI) and not the particular facility / investment or part thereof which has become irregular."
- Para 22: a class "shall not be upgraded merely as a result of rescheduling" unless the Resolution Directions' upgrade conditions are met.
- Para 27: classification and provisioning for transfers of loans follow the Transfer and Distribution of Credit Risk Directions, 2025 (**not in our folder**).

### 3.2 NPA definition by layer

| Item                                                                 | NBFC-BL (para 43)                                                                            | NBFC-ML and UL (para 51; para 56) |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------- |
| Interest overdue                                                     | more than 180 days (43(1))                                                                   | more than 90 days (51(1))         |
| Term loan, instalment or unpaid interest overdue                     | more than 180 days (43(2))                                                                   | more than 90 days (51(2))         |
| Demand or call loan                                                  | more than 180 days from demand/call, or interest overdue more than 180 days (43(3))          | 90 days (51(3))                   |
| Bill, other short-term advances, dues for sale of assets or services | more than 180 days (43(4)-(6))                                                               | 90 days (51(4)-(6))               |
| Lease rental, HP instalment                                          | more than 180 days, each account classified "on the basis of its record of recovery" (43(7)) | 90 days, same proviso (51(7))     |
| All other facilities of the same borrower                            | become NPA when any one becomes NPA (43(8))                                                  | same (51(8))                      |

Para 44 (BL): "The period of more than 180 days for NPA classification as in paragraph 43 stands changed to the overdue period of more than 90 days for applicable NBFCs with the following glide path": more than 150 days by 31 March 2024; more than 120 days by 31 March 2025; "> 90 days" by 31 March 2026. Explanation: the glide path does not apply to NBFCs "already required to follow the 90-day NPA norm". The date of this extract's use is after 31 March 2026, so the **90-day test is the operative default for every layer**. Para 43 still prints 180 days and para 44 amends it; keep both visible in the lender configuration and default to 90 (see 8.1).

### 3.3 Sub-standard and doubtful (age of NPA)

| Item                      | BL                                                                                                                             | ML / UL                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Sub-standard              | NPA for a period "not exceeding 18 months" (45(1))                                                                             | "not exceeding 12 months" (52(1)) |
| Restructured sub-standard | "until the expiry of one year of satisfactory performance under the renegotiated or rescheduled or restructured terms" (45(2)) | same (52(2))                      |
| Doubtful                  | sub-standard "for a period exceeding 18 months" (46)                                                                           | "exceeding twelve months" (53)    |

Loss asset: para 11(1) above, and para 32(3) below. The text has **no fixed day-count for "loss"** other than identification by the NBFC, its auditors or RBI.

### 3.4 Upgrade rules (paras 22, 24-26)

- Para 24: "Loan accounts classified as NPAs may be upgraded as 'standard' asset only if entire arrears of interest and principal are paid by the borrower."
- Para 25: "In case of borrowers having more than one credit facility, loan accounts shall be upgraded from NPA to standard asset category only upon repayment of entire arrears of interest and principal pertaining to all the credit facilities."
- Para 26: upgrade of accounts that became NPA "due to restructuring, non-achievement of ... DCCO, etc." also follows the Resolution of Stressed Assets Directions.
- Para 22: no upgrade by rescheduling alone.

Our reading: a partial payment never upgrades. Because of para 23 and para 25, a borrower with two loans from the same lender stays NPA on both until all arrears on both are cleared. This is lender-by-lender; the text says nothing about cross-lender contagion.

### 3.5 Loan agreement and consumer education (paras 15-17)

For loans sanctioned on or after 31 December 2021 (para 15): the loan agreement must specify "exact due dates for repayment ..., frequency of repayment, breakup between principal and interest, examples of dates of classification as special mention account (SMA) / NPA, etc." (15(1)); the borrower is apprised "at the time of loan sanction and also at the time of subsequent changes" (15(2)); for moratorium loans the "exact date of commencement of repayment" is specified (15(3)). Para 16: earlier loans comply at renewal/review. Para 17: consumer education literature on the website "explaining with examples, the concepts of date of overdue, SMA and NPA classification and upgradation, with specific reference to day-end process" (17(1)); front-line officers must educate borrowers at sanction/disbursal/renewal (17(3)).

---

## 4. Provisioning

### 4.1 Standard assets (general provision)

| Layer                                        | Rate                                                                                                                                                                                                                                                                                             | Para |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| NBFC-BL                                      | 0.25% of the outstanding, "shall not be reckoned for arriving at net NPAs"                                                                                                                                                                                                                       | 48   |
| NBFC-ML                                      | 0.40% of the outstanding (same explanation); "applicable in respect of microfinance loans as well"                                                                                                                                                                                               | 55   |
| NBFC-UL (funded amount outstanding, para 58) | Individual housing loans and loans to SMEs 0.25%; teaser-rate housing 2.00% falling to 0.40% after one year; CRE-RH 0.75%; CRE 1.00%; restructured advances as per the Resolution Directions; **"All other loans and advances not included above, including loans to Medium Enterprises" 0.40%** | 58   |

**There is no separate or higher standard-asset rate for unsecured, retail, personal, consumer or digital loans** in any layer. A retail unsecured loan sits in "all other" (0.40% for ML and UL) or the BL 0.25%. Para 28: standard-asset provision is shown separately as "Contingent Provisions against Standard Assets".

### 4.2 NPA provisioning (para 32, loans and advances "excluding microfinance loan portfolio of NBFC-MFI")

- Para 32(1): sub-standard: "A general provision of ten per cent of total outstanding shall be made."
- Para 32(2)(i): doubtful: "100 per cent provision to the extent to which the advance is not covered by the realisable value of the security to which the NBFC-BL has a valid recourse shall be made." (The text says "NBFC-BL" here although para 32 sits in Chapter II for all NBFCs. See 8.1.)
- Para 32(2)(ii): in addition, 20 to 50 per cent of the secured portion by period as doubtful: up to one year 20%; one to three years 30%; more than three years 50%.
- Para 32(3): loss assets: "The entire asset shall be written off. If the assets are permitted to remain in the books for any reason, 100 per cent of the outstanding shall be provided for."

Consequence for unsecured retail (our reading): where there is no security with "valid recourse", the whole doubtful balance is 100% provided; sub-standard is 10% of total outstanding; loss assets are written off or 100% provided. The doubtful 20/30/50% table applies only to a secured portion and the ageing runs "for which the asset has been considered as doubtful", not from the NPA date.

### 4.3 Hire purchase and leased assets (para 33)

Para 33 prescribes HP and lease provisioning (total dues less unmatured finance charges and depreciated value at 20% a year straight line; overdue-ageing additions of nil, 10%, 40%, 70%, 100% of net book value at 12/24/36/48 months; full provision 12 months after the last instalment). Not relevant to Udofin's unsecured loan product. Para 33(8) is useful as a principle: "Income recognition on and provisioning against NPAs are two different aspects ... The fact that income on an NPA has not been recognised shall not be taken as reason for not making provision."

### 4.4 Project finance, liquidity facilities (paras 30-31)

Project finance general provisions (para 30; CRE 1.25%/1.00%, CRE-RH 1.00%/0.75%, others 1.00%/0.40% for construction/operational phase) and para 31 (securitisation liquidity facility drawn more than 90 days is fully provided) are not relevant to Udofin.

### 4.5 Ind AS NBFCs: prudential floor and Impairment Reserve (paras 34-36)

- Para 34: an Ind AS NBFC "shall hold impairment allowances as required by Ind AS. In parallel, the NBFC shall also maintain the asset classification and compute provisions as per these Directions ... which shall act as the prudential floor for provisioning requirements."
- Para 35: where the Ind AS 109 impairment allowance is lower than the floor, the difference is appropriated from post-tax profit to a separate "Impairment Reserve". The reserve is not reckoned for regulatory capital and "no withdrawals shall be permitted ... without prior permission from the Department of Supervision".
- Para 36: the appropriation counts for the floor, "but shall not be reckoned for calculating net NPAs".

Our reading: every Ind AS lender runs two computations in parallel: ECL stages (Ind AS 109) and the IRACP classification. Udofin's data must support both.

---

## 5. DLG and provisioning (paras 36A-36C, inserted 13 February 2026)

Heading: "C1. Provisioning for portfolios covered by Default Loss Guarantee (DLG) arrangements".

- **Para 36A (quoted in full):** "For loan portfolios covered by Default Loss Guarantee (DLG) arrangements in terms of Chapter III of the Reserve Bank of India (Non-Banking Financial Companies – Credit Facilities) Directions, 2025 and Part B of the Reserve Bank of India (Non-Banking Financial Companies – Transfer and Distribution of Credit Risk) Directions, 2025 both dated November 28, 2025, an NBFC may consider the DLG for determining provisions under the Expected Credit Loss framework across all stages, subject to the requirements as laid down under Indian Accounting Standards, which inter alia require the DLG arrangement to be integral to the contractual terms of the loan and the DLG not being recognised separately."
- **Para 36B:** "An NBFC shall comply with the disclosure requirements as prescribed under IndAS 1."
- **Para 36C (quoted in full):** "Since upon every event of invocation of DLG, the DLG cover reduces to the extent of invocation, an NBFC shall recompute their ECL provisioning requirements across stages, after duly adjusting for the reduced DLG cover."

What this establishes (confirmed) and what it does not:

1. The relief is **permissive** ("may consider"), applies only to the **ECL framework** and so to **Ind AS lenders**, and is "across all stages".
2. The condition comes from Ind AS, not from RBI: the DLG must be "integral to the contractual terms of the loan" and "not ... recognised separately". The DLG arrangement therefore has to be written into the borrower-facing loan contract (or the lender's contractual terms of the loan) for lenders to rely on it. This is a **contract design constraint** for our loan agreement templates, not only a ledger feature.
3. Cover "reduces to the extent of invocation" (36C). The lender must **recompute ECL at each invocation**. Udofin must therefore send the lender, per invocation, the amount invoked, the remaining cover (cap less all invocations) and the effective date, in a form the lender's ECL engine can consume.
4. **Nothing here changes IRACP classification or the 90-day NPA test.** Para 36A is limited to "provisions under the Expected Credit Loss framework". The text is silent on the prudential floor (para 34) for DLG-covered loans. The statement in our matrix (DLG-04) that "NPA recognition and provisioning continue regardless" is **not found in this instrument**; it is a plausible reading only. See 7 and 8.2.
5. **Non-Ind AS NBFCs** (those without ECL) get no express DLG relief in this text. For them classification and the standard IRACP percentages apply to the full loan.
6. The two cross-referenced sources are the Credit Facilities Directions Chapter III (in `docs/regulatory/primary/01`) and **Part B of the Transfer and Distribution of Credit Risk Directions, 2025, which is not in our sources folder**.

---

## 6. Income recognition (paras 37-40)

- Para 37: "The income recognition shall be based on recognised accounting principles."
- Para 38: "Income including interest / discount / hire charges / lease rentals or any other charges on NPA shall be recognised only when it is actually realised. Any such income recognised before the asset became non-performing and remaining unrealised shall be reversed."
- Para 39: where interest moratorium was granted, "income may be recognised on accrual basis for accounts which continue to be classified as 'standard'", evaluated against the restructuring definition in the Resolution Directions.
- Para 40: for loans with a sanction-time interest moratorium that become NPA after the moratorium, "the capitalized interest corresponding to the interest accrued during such moratorium period need not be reversed."

Consequences (interpretation): (a) on classification as NPA the lender reverses unrealised accrued interest and charges, and recognises further income only on cash realisation; (b) **penal charges, fees and other charges** are caught by "any other charges" in para 38, so Udofin's servicing ledger must distinguish interest, principal, penal charges and fees by component for every instalment and payment, and show realised versus accrued. Para 38 also applies to income that Udofin itself passes through or is paid on (but note Udofin is not meant to hold money, rule 1).

---

## 7. What the text does not say (so no statement in our docs may cite this instrument for it)

- SMA-0 / SMA-1 / SMA-2 as day bands (1-30, 31-60, 61-90). Only the 30/60/90-day dating in Illustration I.
- Any provisioning rate specific to unsecured, personal, consumer, retail, digital or short-tenor loans. No special treatment for digital loans or short-tenor loans (no instance of "digital", "tenor", "unsecured" or "personal").
- Write-off policy, procedure, authority, tax, or what happens to recoveries after write-off. Para 32(3) only says loss assets are written off or 100% provided. Write-off is not a day-count event.
- Restructuring rules, restructured-asset provisioning, and upgrade-after-restructuring (all deferred to the Resolution of Stressed Assets Directions, 2025: paras 9, 21, 22, 26, 30(2), 39, 45(2), 52(2), 58).
- The 120-day DLG invocation window and the 5% cap (these are Credit Facilities Chapter III).
- Whether DLG-covered loans are classified, or reported as NPA, differently. Silent.
- Exposure or capital treatment of DLG (see note 10 for the Capital Adequacy Directions).
- Any requirement on the lender's loan management system's data fields or reports. The only data-like duties are the day-end flagging (paras 18-19), the loan-agreement content (15) and Notes to Accounts disclosures (para 41, in the Financial Statements: Presentation and Disclosures Directions, 2025, also not in our folder).

---

## 8. Statements in our existing docs that this text confirms, corrects or does not address

### 8.1 Anomalies in the text itself (check before coding)

1. **BL 180-day vs 90-day.** Para 43 prints 180 days for BL. Para 44 moves BL to 90 days in stages ending 31 March 2026. Treat 90 days as current for all layers, but keep the lender-level config.
2. **"NBFC-BL" in the common provisioning para.** Para 32(2)(i) is in Chapter II (all NBFCs) but names "NBFC-BL". We read it as applying to all NBFCs (counsel to confirm); this is not a different rate.
3. **Different age cut-offs by layer** (18 months BL; 12 months ML/UL) change the sub-standard-to-doubtful date and so the provision on any secured portion; unsecured loans are 100% provided once doubtful.

### 8.2 Against `docs/architecture/collections-and-dlg.md` and `docs/regulatory/controls-matrix.md`

| Statement in our docs                                                                                                   | What this text says                                                                                                                                                                                                                                         | Verdict                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collections doc section 5: `due --> overdue: unpaid after grace`                                                        | Para 11(2), 18: overdue from the due date fixed by the NBFC, flagged at that day-end. No grace in the text.                                                                                                                                                 | **Contradiction risk.** Any grace period must be a collections-contact policy only; it must never delay `overdue_since`, DPD, or SMA/NPA dates. Rename the state or add a separate `regulatory_overdue_date`. |
| DLG-04: "NBFCs using ECL may count DLG only if integral to the loan contract and must recompute ECL on each invocation" | Paras 36A, 36C match. The "integral" test comes from Ind AS, and the lender "may" consider DLG.                                                                                                                                                             | **Confirmed**, with the added point that the contract must embed the DLG (not a side letter).                                                                                                                 |
| DLG-04: "NPA recognition and provisioning continue regardless"                                                          | Not in this text. 36A only concerns ECL provisioning.                                                                                                                                                                                                       | **Not found here**; source it to the Credit Facilities Directions if it is there, else relabel "interpretation".                                                                                              |
| DLG-04 source "RBI/2025-26/210 unverified"                                                                              | The amendment reference in the text is "Reserve Bank of India (Non-Banking Financial Companies – Income Recognition, Asset Classification and Provisioning) Amendment Directions, 2026 dated February 13, 2026". No circular number is printed in the file. | **Correct the citation** to "IRACP Directions 2025, paras 36A-36C, inserted 13 Feb 2026".                                                                                                                     |
| Collections doc: alerts at 90, 110 and 120 days past due for DLG                                                        | 90 days is the NPA line (ML/UL, and BL since 31 Mar 2026). 120 days is from Credit Facilities para 27(1).                                                                                                                                                   | **Consistent**, but the 90-day alert is also the NPA classification trigger; show both in the case view and lender report.                                                                                    |
| Collections doc: DLG invocation leaves "reported status unchanged"                                                      | Para 36A-36C affect ECL provisioning only; classification (paras 19, 23-25) continues to depend on the borrower's arrears.                                                                                                                                  | **Consistent.** Add a test that DLG invocation does not change DPD, SMA tag, NPA date or upgrade eligibility.                                                                                                 |
| Collections doc section 8 item 2 ("how DLG interacts with provisioning")                                                | Answered in section 5 above.                                                                                                                                                                                                                                | Close this item, with the caveats in 5(4), 5(5) and 5(6).                                                                                                                                                     |
| Controls matrix: no IRAC controls row                                                                                   | The text creates lender duties that rely on servicing data (paras 15, 18-19, 24-25, 38, 36C).                                                                                                                                                               | **Gap.** Add rows (proposed IDs IRC-01 to IRC-08, section 9) mapped to this instrument.                                                                                                                       |

---

## 9. Proposed control rows for `controls-matrix.md` (our reading; status "interpretation" unless noted)

| Proposed ID | Requirement for the lender, supported by Udofin data                                                                                                        | Source para            | Status                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------ |
| IRC-01      | Flag an account overdue at the day-end of the due date and keep the **overdue date** as that calendar date.                                                 | 11(2), 18, 19          | confirmed                                  |
| IRC-02      | Compute SMA-1, SMA-2 and NPA as of the day-end of the 30th, 60th and 90th calendar day after the due date (Illustration I); store each classification date. | 19, Illustration I, 51 | confirmed (dating); band labels unverified |
| IRC-03      | Classify borrower-wise: if any facility of a borrower with a lender is NPA, all that lender's facilities of the borrower are NPA.                           | 23, 51(8)              | confirmed                                  |
| IRC-04      | Upgrade from NPA only when **all** arrears of principal and interest on **all** facilities are paid.                                                        | 24, 25                 | confirmed                                  |
| IRC-05      | Loan agreement states due dates, frequency, principal/interest split, SMA/NPA examples; borrower informed at sanction and at each change.                   | 15, 16                 | confirmed                                  |
| IRC-06      | Reverse unrealised accrued income on NPA classification; recognise further income on cash realisation only.                                                 | 38                     | confirmed                                  |
| IRC-07      | For DLG-covered loans, DLG is integral to the loan contract (for ECL relief) and the lender recomputes ECL after every invocation.                          | 36A, 36C               | confirmed                                  |
| IRC-08      | Maintain prudential-floor classification and provisions in parallel to Ind AS impairment.                                                                   | 34-36                  | confirmed                                  |

---

## 10. Data a servicing system must be able to produce (lender-facing; our reading)

For each borrower and each loan, as of any day-end (point-in-time, append-only so history can be replayed):

1. **Due date schedule**: due date, amount due split into principal, interest, penal charges, fees, other charges (paras 15(1), 38).
2. **Overdue date** (the due date that began the current continuous overdue run), overdue amount by component, and **days past due** = day-end date minus the oldest unpaid due date (paras 11(2), 18-19).
3. **Classification date by event**: date of SMA-1 (due date + 30), SMA-2 (+60), NPA (+90 for all layers now; layer-configurable per para 43/51), with the day-end run id that produced it (para 19). The date reflects status at the **day-end of that calendar date**.
4. **Borrower-level roll-up**: the lender's exposure and DPD across all facilities of the same borrower with that lender; NPA status shared across facilities (paras 23, 43(8), 51(8)).
5. **Sub-standard / doubtful / loss stage** with the date each began, using the lender's layer (12 or 18 months) (paras 45-46, 52-53) and **time as doubtful** for secured-portion ageing (para 32(2)(ii)).
6. **Upgrade events**: date all arrears on all facilities cleared and the amounts (paras 24-25).
7. **Realised versus accrued income** and the **reversal on NPA classification**, with the reversal date and amount (para 38).
8. **Restructuring / rescheduling flags** (date, type, performance period start, satisfactory-performance end) to support the Resolution Directions (paras 22, 26, 45(2), 52(2)); we do not hold the instrument.
9. **DLG overlay (separate from the above)**: per DLG set, cap, cumulative invoked, remaining cover, and for every invocation the amount, date and loans covered, so the lender can recompute ECL "across stages" (para 36C). **This must stay in a separate structure from the borrower's balance and status.**
10. **Write-off events** (date, amount, authority reference supplied by the lender) and post-write-off recoveries, as separate entries (the text is silent on procedure; this is for audit trail only).
11. **Loan-agreement evidence**: version of the agreement and SMA/NPA examples shown at sanction and at each change (para 15).

---

## 11. Open questions for counsel (and for the lenders)

1. **Is DLG "integral to the contractual terms of the loan" if Udofin and the lender agree it, but the borrower is not a party?** Para 36A (via Ind AS) requires integration into the contractual terms of the loan. Does a lender-LSP contract suffice, or must the borrower's loan agreement reference the DLG? If the latter, our borrower-facing contract templates and KFS must mention it. Whatever is written must stay consistent with Credit Facilities para 25(2): the borrower's liability is unaffected by DLG invocation.
2. **Non-Ind AS lenders.** Do any of our target lenders lack ECL (many ML and BL lenders now apply Ind AS; smaller ones do not)? For them 36A gives no relief; confirm their commercial appetite for a DLG.
3. **Does the 90/120-day window interplay matter?** NPA at day 91 (ML) versus DLG invocation by day 120: the lender classifies as NPA 30 days before it must invoke. Confirm with the lender how it treats the interim and whether its auditors accept DLG in ECL after the NPA date.
4. **Prudential floor and DLG.** Para 34 requires classification and provisions "as per these Directions" as a floor. The text is silent on whether DLG may lower the floor. Counsel to confirm no relief is assumed.
5. **Part B of the Transfer and Distribution of Credit Risk Directions, 2025** is cross-referenced in para 36A and is not in our folder. Obtain it; it may add DLG conditions for co-lending/assignment portfolios.
6. **Resolution of Stressed Assets Directions, 2025** is needed for restructuring, upgrade-after-restructuring and restructured standard-asset provisioning (the Udofin product, hardship and settlement flows will touch it). Obtain it.
7. **SMA band labels (SMA-0, 1, 2) and their day ranges:** which primary source defines them, so the field and report names match RBI/CIC reporting? (The credit-information note 04 may use them.)
8. **Day count convention for the lender's LMS** (is the due date day 0 or day 1?). Illustration I implies classification on due date + 30/60/90. Confirm each lender's LMS produces the same dates; we store ours only as a reconciliation check and never as the book of record (ADR 0007).
9. **Write-off:** which instrument governs board-approved write-off policy and recovery reporting after write-off, and whether DLG invocation after write-off is possible (the DLG set permits exit "by repayment or write-off").
