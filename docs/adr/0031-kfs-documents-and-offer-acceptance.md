# ADR 0031: KFS, loan documents, acknowledgement, acceptance and signing boundary

Date: 2026-10-14. Status: proposed for owner approval (Phase 07). Related: ADR 0007, 0008, 0014, 0019, 0030.

## Context

Lenders decide and own the record (ADR 0007). The RBI KFS must be given before the contract, with an APR, a proposal
number and a validity of 3/1 working days. Owner decisions: both KFS source modes, pdfkit with Noto fonts, explicit
lender approval before issuance, no invented compliance reviewer, first lenders (MGM Financiers, Megapode Vyapar) not
assumed to be bank/UCB or to generate their own KFS.

## Decisions

1. **Lender data in, document out.** The lender submits `kfs_data_v1`; SQL validates structure and cross-checks it
   against the offer and flags differences. Nothing is changed. Arithmetic cross-checks are skipped only when the lender
   states a rounding note (RBI's own illustration needs one).
2. **Applicability is data**, versioned and two-person approved; the seeded NBFC rule and Annex I layout are drafts.
3. **Working days** come from a lender-confirmed calendar; no calendar means no document. Validity is stamped at
   generation and re-checked at issuance and acceptance.
4. **Immutable, hashed documents**; approval is of an exact hash; preparer ≠ approver by default; issuance is separate.
5. **Acknowledgement and acceptance are borrower acts** recorded with notice version and language; acceptance consumes
   a step-up bound to the offer id inside one transaction. Re-offers create a new revision and need a new acknowledgement.
6. **Signing is a port.** Only a mock exists, refused outside local/test; the database also refuses mock signing unless
   a session setting allows it. An OTP is never recorded as a signature.
7. **Delivery evidence is honest**: provider acceptance ≠ delivery; the SMS notice carries no content.
8. **PDF** by pdfkit; Latin and Devanagari Noto fonts selected per character (the Latin font lacks ₹, the Devanagari
   font lacks ASCII). English and Hindi rendering tests pass.

## Consequences / revisit

Nothing here is production-usable until D-13 (signing structure), D-58 (signature method), D-16 (ranking rule), D-25,
D-37, the compliance approver, lender calendars, approved templates and Hindi wording, and first-lender confirmations
(source mode, category) are resolved. Revisit when any provider is selected.
