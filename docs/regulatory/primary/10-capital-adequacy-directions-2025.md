# Primary-source extract: RBI NBFC Prudential Norms on Capital Adequacy Directions, 2025 (updated to 1 April 2026)

- **Instrument:** Reserve Bank of India (Non-Banking Financial Companies – Prudential Norms on Capital Adequacy) Directions, 2025 ("Capital Adequacy Directions", "CAD")
- **Reference:** RBI/DOR/2025-26/345, DOR.CAP.REC.264/21-01-002/2025-26, 28 November 2025 (signed Sunil T S Nair, CGM). Updated as on 1 April 2026. Amendments visible in the text: para 9(iii) (quarterly profits, from 10 March 2026, Second Amendment Directions, 2026) and para 18(1) item 2(e)(i)-(ii) (high-quality infrastructure project loans, from 1 April 2026, Amendment Directions dated 1 January 2026).
- **Source file:** `docs/regulatory/sources/rbi-nbfc-capital-adequacy-directions-2025-updated-2026-04-01.pdf` (57 pages)
- **Method:** Read in full (pages 1-57, paras 1-58) from the PDF text layer (pdftotext, layout mode). The text layer was clean. The page image of page 22 (the on-balance-sheet risk weight table, items (3)(e)(i)-(ii)) was inspected and matches the text. Paragraph numbers are as printed. Chapter III B (securitisation, paras 19-51) and Chapter IV (CDS, paras 52-53) were read but are summarised only where they bear on Udofin. A few formulae (the CGFMU payout cap formula at para 18(2)(iv)(e), item 3) are rendered imperfectly by the text layer and are not needed here; marked **unreadable in text layer** if ever needed. No paragraph number below was unreadable.
- **Status label for everything quoted here:** confirmed (primary text). Statements about consequences for Udofin or for lenders are our reading (interpretation) unless stated, and need counsel review (section 8).

Important framing: these Directions bind the **NBFC (the lender)**. Udofin is not an NBFC and is not bound. The text never uses "Lending Service Provider", "LSP", "digital lending", "personal loan" or "unsecured" and contains **no recognition of a private third-party guarantee such as a DLG as credit risk mitigation for an NBFC's retail loan**. The only DLG sentence is para 15(3), and it concerns an **NBFC that provides** a DLG. Udofin's capital position (an OPC) is outside this instrument.

---

## 1. Applicability by NBFC layer

### 1.1 Which entities

- Para 3(1): NBFC-D, NBFC-ICC, NBFC-Factor, NBFC-IFC, IDF-NBFC and NBFC-MFI, "subject to layer-wise applicability, unless specified otherwise". Proviso: paras 6(1), 6(2) and 17 do not apply to an NBFC-MFI.
- Para 3(2): HFCs (paras 6(4), 7, 8, 11, 15, 16, 18(2)(iv), 18(3)-18(11), 19-54 "as per layer-wise applicability"). Para 3(3): Mortgage Guarantee Companies (6(4), 7, 8, 11, 15, 16, 54). Para 3(4): CICs (15, 16, 54). Para 3(5): SPDs (16, 54).
- Para 3(6) (not applicable): NBFC-P2P; NBFC-AA; NOFHC; "NBFC not availing public funds and not having any customer interface"; "NBFC-BL having customer interface but not availing public funds".

### 1.2 What each layer must meet (para 6, 10, 11, 17, 54)

| Layer                                                                                | Minimum capital and related requirements in this text                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NBFC-BL, lending against gold jewellery (50% or more of financial assets, para 4(8)) | Tier 1 12% and CRAR 15% of RWAs; Tier 2 not above 100% of Tier 1 (para 6(1))                                                                                                                                                                                                                                         |
| NBFC-BL, other lenders                                                               | **No CRAR or Tier 1 minimum is stated in this text.** Leverage ratio "shall not be more than seven at any point of time" (para 17; leverage ratio = total outside liabilities divided by owned fund, para 4(7)). Whether any other BL capital floor (e.g. net owned fund) applies sits in other Directions (see 8.1) |
| NBFC-ML and above                                                                    | Tier 1 at least 10% of aggregate RWAs (para 6(2)); CRAR at least 15% of RWAs, Tier 2 not above 100% of Tier 1 (para 6(3)); ICAAP (para 54, Chapter V "Applicable to NBFC-ML and above")                                                                                                                              |
| NBFC-UL (additional)                                                                 | CET1 at least 9% of RWAs (para 6(4)); Tier 1 composition per para 11                                                                                                                                                                                                                                                 |
| Top Layer                                                                            | "higher capital charge ... specifically communicated" (para 6(5))                                                                                                                                                                                                                                                    |

CRAR formula (para 6(1) explanation): (Tier 1 + Tier 2) divided by RWAs. Tier 1 ratio and CET1 ratio similarly defined (paras 6(1)-6(4)).

---

## 2. Regulatory capital elements (summary, only where relevant)

- CET1 (para 7), regulatory deductions (para 8), owned fund (para 9), Tier 1 for BL-gold and ML (para 10), Tier 1 for UL (para 11), PDI terms (para 12), Tier 2 (para 13), DTA/DTL (para 14).
- Para 13(iii): Tier 2 includes "General provisions (including that for Standard Assets) and loss reserves to the extent these are not attributable to actual diminution in value or identifiable potential loss in any specific asset ... to the extent of 1.25 per cent of RWAs."
- Para 16 (Ind AS NBFCs): para 16(6): "12 month expected credit loss (ECL) allowances for financial instruments, i.e., where the credit risk has not increased significantly since initial recognition, shall be included under general provisions and loss reserves in Tier 2 capital ... Lifetime ECL shall not be reckoned for regulatory capital (numerator) while it shall be reduced from the RWAs"; para 16(8): the balance in the "Impairment Reserve" shall not be reckoned for regulatory capital.
- Para 8(3): investments and loans to group companies above 10% of owned fund are deducted from CET1. "Companies in the same group" (para 4(2)) includes "common brand name" and "related party". **If Udofin and a lender were in the same group, advances to Udofin would be capped.** Not our structure today (see 8.4).

**Why para 16(6) matters to us:** a lender's Stage 1 versus Stage 2/3 classification moves ECL between Tier 2 capital (12-month ECL) and a reduction of RWAs (lifetime ECL). The more the servicing data lets the lender hold loans at Stage 1, the better its capital ratio. Udofin does not decide this; it supplies DPD and event data (see note 09, section 10).

---

## 3. Risk weights relevant to retail, unsecured and personal loans (para 18(1))

### 3.1 The risk weight (quoted from the table, page 22, verified on the image)

| Item        | Description                                                                                                                                                                  | Risk weight |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 3(e)        | "Other secured loans and advances considered good [Except at (6) below]"                                                                                                     | 100%        |
| **3(e)(i)** | "Consumer credit exposure categorised as retail loans, excluding housing loans, educational loans, vehicle loans, loans against gold jewellery and microfinance / SHG loans" | **125%**    |
| 3(e)(ii)    | "Credit card receivables"                                                                                                                                                    | 125%        |
| 3(c)        | "Loans and advances fully secured against deposits held"                                                                                                                     | 0%          |
| 3(f)        | "Bills purchased / discounted"                                                                                                                                               | 100%        |
| 3(g)        | "Others (To be specified)"                                                                                                                                                   | 100%        |
| 3(b)        | "Inter corporate loans / deposits"                                                                                                                                           | 100%        |
| 3(d)        | "Loans to staff"                                                                                                                                                             | 0%          |

Reading: an unsecured personal or consumer loan to an individual falls in 3(e)(i) at **125%**, unless it is a housing, educational, vehicle, gold or microfinance/SHG loan. The text does not define "consumer credit exposure" or "retail loans" (see 8.2). The table places 3(e)(i) under the heading "Current assets / Other financial assets" as printed.

The same table has high-quality infrastructure project rates (75%/50%, item 2(e)) and domestic sovereign items; they are not relevant to Udofin.

### 3.2 RWA arithmetic implication (our reading)

For a lender at the 15% CRAR floor (ML and above), a 125% risk weight means the equivalent of about 18.75% of the loan amount must be held as capital against an unsecured retail loan (1.25 × 15% = 18.75%), before any buffer. Provisions can be netted only where made (para 18(2)(i)). DLG is **not** recognised as reducing this figure anywhere in the text (section 4).

### 3.3 Netting and zero-risk-weight rules (para 18(2))

- 18(2)(i): "Netting shall be done only in respect of assets where provisions for depreciation or for bad and doubtful debts have been made."
- 18(2)(ii): an asset deducted from owned fund has a 0% risk weight.
- 18(2)(iii): in "the aggregate of funded exposure of a borrower for the purpose of assignment of risk weight, an NBFC shall net off the amount of cash margin / caution money / security deposits (against which right to set-off is available) held as collateral against the advances out of the total outstanding exposure of the borrower." (See 4.5 for why we do not rely on this for DLG cash.)

---

## 4. Guarantees, credit risk mitigation and DLG

### 4.1 The only DLG sentence (para 15(3), quoted in full)

Para 15 (heading "Other adjustments to be made from regulatory capital"), sub-para (3): "In terms of Reserve Bank of India (Non-Banking Financial Companies – Credit Facilities) Directions, 2025, if an NBFC is the Default Loss Guarantee (DLG) provider, it shall deduct the full amount of DLG, which is outstanding, from its capital."

Consequences (interpretation, with the Credit Facilities Chapter III para 26 of note 01 as the cross-reference):

1. A DLG provider that is an **NBFC** takes a rupee-for-rupee deduction of the outstanding DLG (the 5% cap in Credit Facilities para 24(1)). That makes an NBFC-provider's DLG very capital-expensive and is a reason the LSP, not an NBFC, is the usual provider.
2. **A non-NBFC provider such as Udofin has no capital rule in this text.** The deduction does not apply to Udofin. Whether Udofin's own cover instruments (cash deposit, FD lien, bank guarantee) have a capital consequence for **Udofin** is a matter for the Companies Act, accounting standards, and any RBI classification question (8.4), not this instrument.
3. The Directions say nothing on the lender's side of the transaction (see 4.2).

### 4.2 No capital relief for the lender from a third-party DLG (confirmed absence)

- The text has **no paragraph recognising a private guarantee, DLG, or LSP-provided cover as credit risk mitigation** for NBFC loans. A search of the whole file for "guarant", "credit risk mitigat", "DLG" and "default loss" finds only: para 15(3) (DLG deduction), para 18(2)(iv) (government trust-fund schemes), para 18(4) CCF item 1 (NBFC's own guarantees), the CDS chapter, and the securitisation CRM paragraph (para 51(v)).
- Para 18(2)(iv) allows **0% risk weight only** for exposures guaranteed under CGTMSE, CRGFTLIH and individual NCGTC schemes, and only if the guarantee meets the commercial-bank CRM standards (paras 167-176 of the Commercial Banks Capital Adequacy Directions, 2025: "direct, explicit, irrevocable and unconditional") and the other conditions (18(2)(iv)(a)-(e)). **A DLG is not one of these** and, per Credit Facilities para 21, DLG may not even be used on loans under such trust-fund schemes.
- Therefore, on this text: **a loan covered by Udofin's DLG carries the same risk weight to the lender (125% for unsecured consumer credit) as if there were no DLG.** The lender's benefits from DLG appear in ECL provisioning (note 09, para 36A) and in economics, not in RWAs. This is an absence of rule, not an express prohibition (confirmed absence; the conclusion is our reading).
- The bank-guarantee form of cover (Credit Facilities para 22; cover instruments in our design) is a guarantee issued **by a bank in the lender's favour**. This text gives the lender no express risk-weight substitution for such a bank guarantee on a retail loan either; the commercial-bank paras 167-176 are referred to only in the scheme context of para 18(2)(iv)(a). Counsel to confirm (8.3).

### 4.3 Where an NBFC's own guarantees are weighted (not Udofin, but note)

- Para 18(4), item 1: "Financial and other guarantees" CCF 100%. Para 18(3)(ii): credit-equivalent amount × 100% for "others" (20% banks, 0% governments). Applies to guarantees an NBFC gives, so it is the reason a **lender-group NBFC DLG provider** would carry both a 100% CCF and the para 15(3) deduction.
- Para 18(3)(ii) and the table note under item (11): counterparty risk weight "shall be 100 per cent in respect of all borrowers or zero per cent if covered by Government guarantee".

### 4.4 Credit protection chapters (not applicable to DLG)

- Chapter IV (paras 52-53): an NBFC "shall participate in CDS market as a user ... buy credit protection only to hedge their credit risk on corporate bonds it holds". CDS is the only credit-derivative protection recognised and only for corporate bonds. Not relevant to retail loans or DLG.
- Para 53(7) (reporting): "On a quarterly basis, an NBFC shall report 'total exposure' in all cases where it has assumed exposures against borrowers in excess of the normal single / group exposure limits due to the credit protections obtained by it through CDS, guarantees or any other permitted instruments of credit risk transfer, to the Regional Office of Department of Supervision". This is an exposure-limit reporting duty, relevant only if a DLG ever raised a lender's exposure beyond single/group limits. Unlikely for retail loans; mention to counsel.
- Securitisation (paras 19-51): para 32: "When an NBFC provides implicit support to a securitisation, it shall, at a minimum, hold capital against all the underlying exposures ... as if they had not been securitised" and may not recognise gain on sale. Para 27 conditions require the originator not be "obligated, contractually or otherwise, to retain the risk of the transferred exposures". If a lender later securitises or assigns a DLG-covered pool, **a guarantee that compensates the originator for losses is credit enhancement or implicit support** and must be tested by the lender against paras 27 and 32 and the Securitisation and Transfer Directions. Udofin has not modelled this. See 8.5.

### 4.5 Cash held by the lender under a DLG: no netting assumed

Para 18(2)(iii) nets "cash margin / caution money / security deposits ... held as collateral against the advances" of **a borrower**. A DLG cash deposit or FD lien is provided by **the DLG provider**, covers a **portfolio** and is not a borrower's margin. The text does not say the lender may net DLG cash against the loans' exposure, nor may it treat the loans as "fully secured against deposits held" (item 3(c), 0%). **We must not assume either**. Counsel and each lender's auditor should say whether either argument is available; the conservative position is 125% on the whole loan amount.

---

## 5. Treatment of provisioning in capital (what ties to note 09)

- Impairment Reserve not in regulatory capital (paras 8(4), 16(8); note 09 paras 35-36).
- General provisions in Tier 2 limited to 1.25% of RWAs (para 13(iii)).
- Ind AS NBFCs: Stage 1 (12-month) ECL counts as general provision for Tier 2; lifetime ECL is deducted from RWAs rather than counted in capital (para 16(6)).
- IRACP para 36A allows an NBFC to consider DLG in ECL "across all stages", so a DLG reduces ECL and may therefore reduce the Tier 2 numerator (Stage 1) or the RWA reduction (Stage 2/3). The net capital effect is lender-specific (interpretation; not stated in either text).

---

## 6. Other items that touch our design

- **Unrealised profit under co-lending** (para 15(2)): deducted from CET1 or net owned funds until maturity. Relevant only if Udofin's lenders use co-lending.
- **Loans to staff** 0% (item 3(d)); **Credit card receivables** 125% (item 3(e)(ii)). Revolving credit offered digitally cannot take a DLG (as stated in matrix DLG-06; source not re-checked here), so the credit-card row does not meet our product.
- **ICAAP (para 54):** ML and above must "factor in credit risk, market risk, operational risk, and all other residual risks"; "Pillar 2 capital will not be insisted upon". A DLG-dependent portfolio's **concentration on one guarantor** is the kind of residual risk the lender's ICAAP should consider (interpretation).

---

## 7. What the text does not say (so no statement in our docs may cite this instrument for it)

- Any capital or risk-weight benefit from a DLG, from a bank guarantee in the lender's favour, or from cash or an FD lien held under a DLG.
- Any capital rule for an LSP or for a non-NBFC DLG provider.
- Definitions of "consumer credit exposure" and "retail loans" (it uses them in 3(e)(i)).
- Any treatment specific to digital loans, small-ticket loans or short-tenor loans, or "unsecured" as a category (the 125% row is by borrower type, not by security).
- A CRAR minimum for non-gold NBFC-BL.
- Single borrower / group exposure limits (they are in the Concentration Risk Management Directions, 2026, which this text names but does not reproduce).
- The CRM standards (paras 167-176 of the Commercial Banks Capital Adequacy Directions, 2025), which this text imports for scheme guarantees. **Not in our sources folder.**

---

## 8. Open questions, statements checked against our docs, and contradictions

### 8.1 Open questions for counsel and lenders

1. **Layer of each lender.** The minimum capital rules turn on BL vs ML+ (and BL-gold). Record the layer in the onboarding checklist; the same lender row must drive the IRACP parameters (note 09, section 1.2).
2. **Meaning of "consumer credit exposure categorised as retail loans".** Which instrument defines it? Do small-ticket digital personal loans always fall in 125%? (Affects pricing and the lenders' appetite.)
3. **Does any RBI instrument give a lender capital recognition for a bank guarantee in its favour that backs a DLG?** The commercial-bank CRM paras 167-176 would need to be read and the guarantee would need to be "direct, explicit, irrevocable and unconditional". A bank guarantee under the DLG design may be conditional on invocation timelines; this needs a legal read.
4. **Is Udofin, by giving a continuing 5% guarantee, carrying on a financial activity that raises an NBFC-registration question?** This text does not address it; matrix open question 9 already flags it. If Udofin ever became an NBFC, para 15(3) (full DLG deduction) and CCF 100% on guarantees would apply to it, which would make a 5% DLG capital-expensive.
5. **Group status.** Para 4(2) treats "common brand name" and "related party" as group links. If any lender is a related party of Udofin (or a group product), para 8(3) exposure limits and deductions could apply to that lender. Confirm no lender is in Udofin's group.
6. **Securitisation or assignment of DLG-covered pools** by a lender: how paras 27 and 32 and the Securitisation / Transfer Directions treat a guarantee that makes the originator whole. Udofin should refuse to extend DLG to loans a lender intends to sell until counsel opines.

### 8.2 Against `docs/architecture/collections-and-dlg.md` and `docs/regulatory/controls-matrix.md`

| Statement in our docs                                                                                                                                                      | What this text says                                                                  | Verdict                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credit Facilities para 26 (note 01): "Capital treatment follows the Capital Adequacy Directions; an NBFC that is a DLG provider deducts the outstanding DLG from capital." | CAD para 15(3), quoted in 4.1.                                                       | **Confirmed**; the CAD sentence is about NBFC providers only.                                                                                                                                                                                        |
| Collections doc/matrix: lender benefits are described mainly through cap, invocation and ECL                                                                               | No capital benefit in CAD. The lender's RWA is unchanged by DLG.                     | **Add a note**: do not market DLG as a capital-relief or "risk-free" product for lenders; value is in ECL (note 09 para 36A) and economics. Sales and contract language must avoid "credit risk mitigation" or "risk transfer for capital purposes". |
| Matrix DLG-01 open question "capital at ..." (OPC capital)                                                                                                                 | CAD does not prescribe capital for a non-NBFC provider.                              | **Consistent**; capacity is by Credit Facilities para 20(3) (auditor declaration), not CAD.                                                                                                                                                          |
| Matrix open question 9 (whether large guarantee exposure changes Udofin's regulatory characterisation)                                                                     | CAD silent on characterisation; applies para 15(3) only if the provider is an NBFC.  | **Not answered by this text**; keep open.                                                                                                                                                                                                            |
| Matrix DLG-06 / collections doc: no revolving credit under DLG                                                                                                             | CAD 125% rows for credit cards confirm RBI's separate treatment of revolving credit. | **Consistent.**                                                                                                                                                                                                                                      |
| Collections doc: DLG `cover_instruments` as cash, FD lien, bank guarantee                                                                                                  | CAD gives no RWA netting for any of them on retail loans (4.2, 4.5).                 | **No contradiction**; do not describe the instruments as "collateral" that reduces the lender's capital.                                                                                                                                             |

No direct contradiction with `collections-and-dlg.md` or `controls-matrix.md` was found in this instrument. The matrix has no capital-adequacy row; propose adding CAP-01 to CAP-05 (section 9).

---

## 9. Proposed control rows for `controls-matrix.md` (our reading; status "interpretation" unless stated)

| Proposed ID | Requirement                                                                                                                                                                            | Source para                                  | Status                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| CAP-01      | Record each lender's layer and minimum capital regime (BL, BL-gold, ML, UL) at onboarding; do not assume a CRAR floor for non-gold BL.                                                 | 6, 17                                        | confirmed (text); applicability per lender interpretation |
| CAP-02      | Unsecured consumer loans are risk-weighted at 125% by the lender; the DLG gives no RWA relief; marketing and contracts must not claim capital relief.                                  | 18(1) item 3(e)(i); 15(3) and absence of CRM | confirmed (rate); absence of DLG relief is our reading    |
| CAP-03      | If the DLG provider were an NBFC it would deduct the full outstanding DLG from capital; Udofin must not become or contract through an NBFC DLG provider without counsel review.        | 15(3)                                        | confirmed                                                 |
| CAP-04      | DLG invocation data (amount, remaining cover, date) is provided to each lender so it can recompute ECL, which flows into Tier 2 / RWA through 12-month versus lifetime ECL.            | 16(6); IRACP 36A, 36C                        | interpretation                                            |
| CAP-05      | Lenders using a DLG and selling or securitising the pool must test the DLG as implicit support or credit enhancement; Udofin does not extend DLG to such pools without counsel review. | 27, 32                                       | interpretation                                            |

---

## 10. Data and design points drawn from this text (for the servicing data model and DLG ledger)

1. Per lender: layer (BL / BL-gold / ML / UL), Ind AS yes or no. These switch IRACP and capital behaviour.
2. Per loan: product type flag showing whether the loan is "consumer credit categorised as retail" (125%) versus excluded categories (housing, education, vehicle, gold, microfinance/SHG), so the lender's RWA feed is correct. Udofin's loan products will mostly be 125%.
3. Per loan and per day: DPD, SMA/NPA dates and ECL-relevant stage-driving events, from note 09. These drive the lender's ECL and therefore its Tier 2 and RWA numbers (para 16(6)).
4. Per DLG set: outstanding cover (cap less invoked) as at any date, so lender's ECL can be recomputed after each invocation (IRACP 36C) and, if ever relevant, so Udofin can show counsel its maximum exposure (not a capital figure, which this text does not set for Udofin).
5. Do not store or report any "capital relief", "RWA benefit" or "risk-weight" figure in our system as if Udofin computed it. Those are lender regulatory returns; Udofin supplies the inputs only (rule 1: lenders decide).
