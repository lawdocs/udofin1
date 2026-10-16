# Grievance Redressal, RBI Ombudsman, ADR (Mediation/Arbitration) and Collections Conduct for Udofin (as of 2026-10-10)

**Executive summary.** As of 10 October 2026 the **Reserve Bank – Integrated Ombudsman Scheme, 2026 (RB-IOS 2026)** is in force. RBI issued it on 16 January 2026, it took effect on **1 July 2026**, and it repealed RB-IOS 2021. RB-IOS 2026 keeps the "complain to the regulated entity (RE) first" rule. A borrower may go to the RBI Ombudsman if the RE gives no reply within **30 days** (or a longer period that RBI, NPCI or card-network rules set), or if the reply does not satisfy them. The 2026 scheme also brings a much **shorter window: the borrower must file with the Ombudsman within 90 days**, counted from when the RE's timeline expires or from the RE's last communication, whichever is later. It also raises the compensation caps (₹30 lakh for consequential loss and ₹3 lakh for harassment or mental anguish). It **still treats a complaint as non-maintainable when the same grievance is pending before, or has been decided by, a court, tribunal, arbitrator or other forum.** Under the Digital Lending Directions, both the RE and the LSP must have a nodal grievance redressal officer (GRO), display that officer's details on the DLA, the website and in the KFS, and keep the RB-IOS route open. Those Directions also say grievance redressal stays the RE's responsibility.

For Udofin this means:

- Udofin **may not** send unresolved complaints to Equator, a private ADR platform owned by the same group, _before or instead of_ the RBI Ombudsman.
- An Equator **arbitration** would actually _destroy_ the borrower's Ombudsman remedy.
- An Equator **mediation** offered after the RE's final reply could use up the 90-day Ombudsman window.
- Equator's common ownership with an LSP that carries a 5% DLG creates a conflict of interest. This conflict is serious under Section 12(5) and the Seventh Schedule of the Arbitration Act, and under the Supreme Court Constitution Bench ruling of 8 November 2024 (_CORE v ECI-SPIC-SMO-MCML_) against unilateral appointment.

On collections:

- Providing DLG does **not** give Udofin any right to collect. Udofin can collect only as the RE's disclosed, outsourced recovery agent, under the RE's recovery and outsourcing rules. That means calls only between 08:00 and 19:00, no intimidation and no contact with third parties, with the RE remaining responsible for Udofin's conduct.
- The design that complies is: a ticketed complaint lifecycle that starts the RE's clock the moment Udofin receives a complaint; human-only adverse decisions, with the AI disclosed as AI and always able to hand over to a person; a final reply that always points to RB-IOS and the CMS portal; and an Equator referral only as a voluntary, later, free and conflict-disclosed **mediation** option. No arbitration clauses in retail loan documents.

> **Method and verification limits (read first).** In this session the egress proxy blocked every `WebFetch`, including rbi.org.in, rbidocs.rbi.org.in and all secondary sites (DNS/CONNECT 403). The shared web-search budget ran out after six searches, all of them on RB-IOS 2026. **The RB-IOS 2026 findings therefore come from search-result extracts of RBI's press release and FAQ, copies of the scheme hosted by banks, and law-firm and press summaries. Everything else (Digital Lending Directions, recovery-agent circulars, Internal Ombudsman, Mediation Act commencement, the CORE holdings, DLG) comes from the researcher's knowledge up to mid-2026 and could not be re-checked online.** Those items are marked [likely] or [unverified]. I give no paragraph numbers or URLs for them. The owner's "28 Nov 2025 and 31 Jul 2026 master directions" could **not** be checked (see Open questions).

---

## Findings

### 1. RB-IOS 2026: what changed and what REs must do

**Issuance and commencement.** RBI issued the _Reserve Bank – Integrated Ombudsman Scheme, 2026_ on 16 January 2026. It came into force on **1 July 2026**, and RB-IOS 2021 stood repealed from that date **[confirmed – search extracts of the RBI press release and scheme copies]** ([RBI press release – RB-IOS 2026](https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=62052) (16 Jan 2026); [RB-IOS 2026 text hosted by SBI](https://sbi.bank.in/documents/136/1364568/Reserve+Bank+Integrated+Ombudsman+Scheme+2026.pdf/f7e84648-b034-bf5d-95f9-76a4d3ef9a4a?t=1783668512462) (2026)). The draft "Reserve Bank – Ombudsman Scheme, 2025" came out on 7 October 2025 **[likely – secondary]** ([Business Standard](https://www.business-standard.com/finance/news/central-state-co-op-banks-brought-under-ambit-of-rbi-s-ombudsman-scheme-125100701358_1.html) (7 Oct 2025)).

**Who is covered.**

- **[likely]** Coverage includes commercial banks, RRBs, co-operative banks (including state and central co-operative banks, newly added), eligible NBFCs, non-bank PPI issuers and credit information companies.
- **[likely]** NBFC coverage depends on having a **customer interface**.
- **[unverified]** Whether the 2021 asset-size threshold of ₹100 crore still applies to non-deposit-taking NBFCs, and whether HFCs are now covered. The 2021 scheme excluded HFCs.

Sources: [Vinod Kothari – RB-IOS 2026 key changes](https://vinodkothari.com/2026/01/rbi-integrated-ombudsman-scheme-2026-key-changes/) (Jan 2026, secondary); [AffairsCloud](https://affairscloud.com/rbi-issues-reserve-bank-integrated-ombudsman-scheme-rb-ios-2026-to-simplify-complaint-resolution/) (Jan 2026, secondary).

**Udofin consequence [interpretation]:** a small partner NBFC that falls outside RB-IOS leaves the borrower with a much weaker route (RBI CEPC). This is a partner-selection and disclosure issue.

**The 30-day rule and the new 90-day window.**

- **[confirmed – RBI FAQ via search extract]** The complainant must first complain to the RE "in writing or through any other mode".
- **[confirmed – RBI FAQ via search extract]** The complainant may approach the RBI Ombudsman if there is no reply within **30 days**, or within any longer period that RBI, NPCI or card-network guidelines specify, whichever is higher. The complainant may also approach the Ombudsman if they are not satisfied with the reply.
- **[confirmed – RBI FAQ via search extract; one secondary source still says "1 year", which appears to be a leftover from the 2021 rules]** The complaint must reach the Ombudsman **within 90 days** of the later of: (a) the expiry of that timeline, or (b) the RE's last communication. Under RB-IOS 2021 the window was one year, or one year and 30 days where the RE never replied.

Sources: [RBI FAQs on RB-IOS 2026](https://www.rbi.org.in/commonman/Upload/English/FAQs/PDFs/RBIOS01072026.pdf) (1 Jul 2026); [Business Standard – timelines](https://www.business-standard.com/finance/personal-finance/rbi-ombudsman-scheme-know-complaint-timelines-compensation-appeal-rules-126070800754_1.html) (8 Jul 2026).

**Why this matters to Udofin:** anything that pulls the borrower into a side process after the RE's final reply (an AI chatbot loop, an Equator mediation) **uses up the 90-day window**.

**Non-maintainability: the "arbitrator / other forum" bar.**

- **[confirmed – RE-published salient features of RB-IOS 2026]** A complaint is not maintainable where the same grievance is **pending before, or has been settled or decided on merits by, any court, tribunal, arbitrator or other judicial/quasi-judicial forum**. The same applies where the grievance is already pending before, or has been dealt with by, the Ombudsman.
- **[likely]** Complaints filed on the portal go through a system-based maintainability check and may be rejected at the outset.

Sources: [Axis Bank – Salient features RB-IOS 2026](https://application.axis.bank.in/docs/Salient_Features_Integrated_Scheme_2026.pdf) (2026); [Navi – Salient features RB-IOS 2026](https://public-assets.prod.navi-tech.in/navi-website-assests/documents/Salient_Features_Integrated_Ombudsman_Scheme_2026_20260630194008.pdf) (30 Jun 2026); [Vinod Kothari](https://vinodkothari.com/2026/01/rbi-integrated-ombudsman-scheme-2026-key-changes/) (Jan 2026).

**[interpretation]** Starting an Equator arbitration (by either side) over the same grievance makes an RB-IOS complaint non-maintainable. A settlement reached in Equator mediation would generally end the grievance on the merits. Whether private mediation counts as a "forum" is arguable, but a signed settlement with a release would in practice defeat a later complaint.

**Compensation, Deputy Ombudsman and appeal.**

- **[likely – several secondary sources agree]** Caps are ₹30 lakh for consequential loss (up from ₹20 lakh) and ₹3 lakh for loss of time, expenses, harassment and mental anguish (up from ₹1 lakh). There is no cap on the amount in dispute.
- **[likely]** "Deficiency in service" now covers _all_ services provided by REs.
- **[likely]** Deputy Ombudsmen may reject non-maintainable complaints and facilitate settlements.
- **[likely]** Appeals go to the Appellate Authority within 30 days, which can be extended by 30 more.

Sources: [BusinessToday](https://www.businesstoday.in/personal-finance/banking/story/rbi-revamps-customer-grievance-redressal-heres-what-changes-for-bank-nbfc-customers-541259-2026-07-06) (6 Jul 2026); [Upstox explainer](https://upstox.com/news/business-news/financial-regulations/explainer-rbi-notifies-integrated-ombudsman-scheme-2026-who-can-complain-and-how/article-187895/) (2026); [Candour Legal](https://candourlegal.com/rbi-integrated-ombudsman-scheme-2026-banks-nbfc-customers/) (Jul 2026).

**The point for Udofin:** the scheme already offers a **free, RBI-run conciliation route**, so a private ADR step adds little for a borrower and carries a lot of risk.

**What REs must do and tell customers.**

- **[likely]** Appoint a **Principal Nodal Officer** at head office, of at least General Manager rank or equivalent, and report changes to RBI CEPD.
- **[likely]** Prominently display the PNO's name and contact details, the **Centralised Receipt and Processing Centre (CRPC)** address and the link to the RBI complaint portal at branches and places of business, and publish the scheme on the website.
- **[likely]** Complaints are lodged on **cms.rbi.org.in**.
- **[likely; unverified for 2026]** The RE files its written version with supporting documents within about 15 days of the Ombudsman's notice.
- **[likely, from the Internal Ombudsman directions; 2026 wording unverified]** The RE's final or rejection reply must tell the customer that they can approach the RBI Ombudsman.

Sources: [Credila – RB-IOS 2026 salient features](<https://www.credila.com/pdfs/Salient-Features-RBI-IO-Scheme-2026-(2).pdf>) (2026); [Piramal Finance – salient features](https://www.piramalfinance.com/content/dam/piramalfinance/pdf/stakeholder/salient-features/pfl-salient-features-english.pdf) (2026); [Standard Chartered – RB-IOS 2026 page](https://www.sc.bank.in/important-information/client-experience/banking-ombudsman/) (2026).

**Who:** these are **RE** obligations. Udofin, as the RE's agent and the borrower's main interface, should reproduce them on the DLA for each partner RE **[recommendation]**.

### 2. NBFC grievance machinery: GRO, PNO, Internal Ombudsman

- **Fair Practices Code (RE).** **[likely – from the NBFC FPC in the Scale-Based Regulation Master Direction of 19 Oct 2023, which the Nov 2025 consolidation reportedly carried into the NBFC "Responsible Business Conduct" directions; unverified this session]** The Board sets a grievance redressal mechanism under which disputes about decisions of the lender's staff are "heard and disposed of at least at the next higher level". The NBFC displays the GRO's name and contact details and the escalation route (now the RBI Ombudsman/CMS) at branches and on its website. The FPC also bars undue harassment in recovery, such as "persistently bothering the borrowers at odd hours" and "use of muscle power".
- **Outsourced services (RE).** **[likely]** Under RBI's outsourcing directions for NBFCs, the RE's grievance machinery must also handle complaints about services delivered by the outsourced agent. This covers an LSP acting as recovery agent. The GRO's details and response timelines must be publicised.
- **Internal Ombudsman (RE).** **[likely – Master Direction on Internal Ombudsman for Regulated Entities, 29 Dec 2023, now reportedly consolidated; unverified]** For NBFCs this applies to: (i) deposit-taking NBFCs with **10 or more branches**; and (ii) non-deposit-taking NBFCs with **assets of ₹5,000 crore or more and a public customer interface**. These REs must escalate complaints they propose to reject wholly or partly to the IO _before_ replying. The final reply must carry the IO's decision and mention the RB-IOS option.
  - **Udofin consequence:** the workflow must hold a proposed rejection for RE/IO review. It must never let Udofin staff or the AI issue a rejection.
- **Disclosure (RE).** **[likely]** NBFCs covered by RB-IOS disclose complaint statistics, including the top grounds, in their annual reports. Udofin should feed partner REs the MIS for complaints sourced through Udofin.

### 3. Digital Lending Directions: grievance obligations for LSPs and DLAs

**[likely – RBI (Digital Lending) Directions, 2025 (8 May 2025), carrying forward para-level text from the 2 Sep 2022 guidelines; reportedly folded into the Nov 2025 consolidated directions; the exact current numbering is unverified]**

- **Who appoints GROs:** both the **RE and its LSPs** must have a nodal **grievance redressal officer** for digital-lending complaints. That GRO also handles complaints against the RE's or LSP's DLAs.
- **Where the details appear:** the GRO contact details must be **prominently displayed on the RE's website, the LSP's website and the DLA, and in the KFS**.
- **Complaint channel:** the borrower must be able to lodge a complaint **on the DLA and on the website**.
- **Responsibility stays with the RE.** If the RE does not resolve a complaint against the RE _or its LSP_ within the stipulated period (30 days), the borrower may complain on the CMS portal under RB-IOS.
- **Link to the RE:** the DLA must link to the RE's website, which carries product, lender, LSP and customer-care details and the **Sachet** portal link.
- **Multi-lender LSPs** (Udofin's model): the LSP must show every matching offer in an unbiased way. Each offer shows the RE's name, amount, tenor, APR, instalment, penal charges and a link to the KFS. No dark patterns.
- **Recovery:** the KFS must name the **LSP acting as recovery agent** and authorised to approach the borrower. If recovery is handed to an agent, or the agent changes, the borrower must be told by email or SMS **before** the agent makes contact.
- **Repayments** must go directly into the RE's bank account, with no LSP pass-through or pool account.
- **Data:** DLAs must not access the phone's files and media, contact list, call logs or telephony functions. They may use the camera, microphone and location one time, with consent, for onboarding/KYC. LSPs may store only minimal basic borrower data.

The data rule shapes how Udofin may keep complaint evidence: it should hold that evidence **as the RE's processor, under the RE's instructions** **[interpretation]**.

### 4. Private ADR (Equator) before or instead of the Ombudsman

1. **Before the RE's 30 days have run.** No RBI instrument lets an RE or LSP add a mandatory private ADR step. The RE's clock runs from receipt, and an Equator referral cannot pause it. Sending a complaint outside the RE's own redressal process within the 30 days may leave the RE in breach of its grievance and FPC duties. **[interpretation]**
2. **Instead of the Ombudsman.** An arbitration clause or referral that ends in an Equator arbitration makes RB-IOS non-maintainable under the forum bar (§1). This strips the borrower of a **free** regulatory remedy with compensation of up to ₹30 lakh + ₹3 lakh. RBI would very likely see it as an unfair practice inconsistent with the FPC and the DL Directions' requirement to make the RB-IOS route known. A standard-form clause that removes it could be an **"unfair contract"** under s.2(46) of the Consumer Protection Act 2019, which State and National Commissions can declare void. **[interpretation; CPA provisions likely]**
3. **Consumer forum stays open.** In _Emaar MGF Land v Aftab Singh_ (SC, 2018), the Supreme Court held that an arbitration clause does not oust a Consumer Commission's jurisdiction over a consumer dispute. The consumer may choose the statutory forum, and CPA 2019 s.100 makes that Act additional to other laws. Banking and lending services count as "service". Pecuniary jurisdiction is up to ₹50 lakh for the District Commission, ₹50 lakh–₹2 crore for the State Commission, and above ₹2 crore for the National Commission (2021 Rules). Complaints can be filed online (e-Daakhil/e-Jagriti). **[likely]**
4. **Dark patterns.** If the UI steers borrowers to Equator, for example by showing it first, pre-ticking consent, using false urgency or hiding the RB-IOS link, that risks breaching the CCPA _Guidelines for Prevention and Regulation of Dark Patterns, 2023_ (30 Nov 2023). It would also breach the DL Directions' bar on dark patterns for multi-lender LSPs. **[likely]**
5. **Disclosures needed if Equator is offered at all** **[recommendation]**:
   - that the option is voluntary and not a condition of any relief or loan;
   - that the RB-IOS and Consumer Commission routes remain open;
   - that **arbitration would bar RB-IOS**;
   - that the 90-day RB-IOS deadline keeps running, with the date shown;
   - Equator's **common ownership with Udofin** and Udofin's DLG exposure;
   - fees, which should be zero for the borrower;
   - who appoints the neutral;
   - the legal status of any settlement.

### 5. Mediation Act, 2023

- **Content [likely]:**
  - Mediation, including **pre-litigation mediation** (s.5), is voluntary.
  - A signed **mediated settlement agreement (MSA)** is final and binding and can be enforced under the CPC "as if it were a judgment or decree" (s.27). It can be challenged only on limited grounds (fraud, corruption, impersonation, or a dispute not fit for mediation) within 90 days (s.28).
  - **Online mediation** (s.30) needs the parties' written, including electronic, consent and must preserve confidentiality.
  - Mediators must disclose conflicts and may be replaced.
  - **Mediation service providers** are to be recognised or registered by the **Mediation Council of India**.
  - Mediation ends within 120 days, extendable by 60.
- **Commencement [unverified as at Oct 2026]:** on 9 October 2023 the Centre notified only selected provisions, broadly the preliminary sections, Mediation Council provisions and some miscellaneous and amending provisions. As of the researcher's last verified information, the core provisions (process, MSA enforcement under s.27, online mediation under s.30, MSP registration) had **not** been brought into force, and the Mediation Council of India had not been constituted. **If that is still the case, a settlement from an Equator mediation is enforceable only as a contract, not as a decree,** and there is no statutory registration framework for Equator as an MSP.
- **Udofin consequence:** do not market Equator outcomes to borrowers as "court-enforceable" without written verification.

### 6. Arbitration and Conciliation Act 1996: online arbitration, seat, independence, CORE

- **Online arbitration [likely].** The Act allows arbitration agreements made through electronic communications (s.7(4)(b)) and lets parties set their own procedure. Electronically signed awards and video hearings are accepted in practice. The **seat** (s.20) fixes which court supervises the arbitration, so a consumer-facing design should make the borrower's home district the seat. Awards can be challenged under s.34 (3 months + 30 days) and are enforced as decrees (s.36). State stamp duty rules apply to awards.
- **Independence [likely].** Under s.12(5) read with the **Seventh Schedule**, anyone whose relationship with the parties, counsel or subject matter falls in that Schedule cannot be appointed, "notwithstanding any prior agreement". Only an express written agreement made _after_ the dispute arises can waive this. The Schedules define **"affiliate" to include all companies in one group, including the parent**. Listed relationships include a business relationship with a party, and a management role or controlling influence in an affiliate of a party involved in the dispute. Related cases:
  - _TRF v Energo_ (2017): an ineligible person cannot nominate an arbitrator.
  - _Perkins Eastman v HSCC_ (2019): a party with an interest in the outcome cannot unilaterally appoint a sole arbitrator.
  - _Bharat Broadband_ (2019): an appointment by an ineligible person is void.
- **CORE v ECI-SPIC-SMO-MCML (JV), Constitution Bench, 8 Nov 2024 [likely – holdings from memory, not re-verified]:**
  - the principle of equal treatment applies at the appointment stage;
  - a clause cannot force the other party to choose from a panel curated by one party;
  - unilateral appointment of a sole arbitrator raises justifiable doubts about independence and impartiality, and in public–private contracts offends Article 14;
  - the express-waiver rule in the s.12(5) proviso applies;
  - the ruling applies **prospectively** to appointments made after the judgment.
- **Application to Equator [interpretation]:**
  - Udofin is not the creditor, but it is the RE's agent and its **DLG means it bears the first loss**. In a dispute about Udofin's collection conduct it is effectively the respondent.
  - If Equator is in Udofin's group and **picks or administers the neutral**, this is functionally a unilateral appointment by an interested party's affiliate. Awards would face s.12(5)/s.34/s.36 challenges.
  - Bulk, lender-initiated "recovery arbitrations" against retail borrowers through an affiliated platform carry the highest risk of being set aside and of attracting regulatory and reputational damage.
- **Developments [unverified]:** the Department of Legal Affairs published a draft Arbitration and Conciliation (Amendment) Bill in October 2024, covering electronic proceedings, institutional arbitration and appellate tribunals. Whether it was enacted could not be checked. The Arbitration Council of India / institutional grading provisions were reported as not yet operational.

### 7. Lok Adalat, ODR policy, and 2025–2026 ODR developments

- **Lok Adalat [likely].** Under the Legal Services Authorities Act 1987, a Lok Adalat award, including in pre-litigation matters, is deemed a civil court decree, is final and cannot be appealed (s.21). It is free. Permanent Lok Adalats handle public utility services, which many states have notified to include banking and finance. Banks widely use National Lok Adalats for retail NPAs. This is an independent, low-cost **settlement channel for REs** that is better than an affiliated private arbitration.
- **NITI Aayog [likely].** _Designing the Future of Dispute Resolution: The ODR Policy Plan for India_ (Nov 2021, Expert Committee chaired by Justice A.K. Sikri) recommends ODR that is voluntary and consent-based, with neutrality, transparent fees, confidentiality and data protection, and self-regulation by ODR providers under published design and ethics principles. It is policy, not binding law.
- **Sector ODR [likely]:**
  - RBI required ODR for failed digital-payment transactions in an August 2020 circular, with operators to implement it by 1 January 2021.
  - SEBI's 2023 framework routes securities disputes through the SMART ODR portal to empanelled ODR institutions with SEBI-set fees. It is a useful model for neutral empanelment.
- **2025–2026:** **[unverified]** No RBI framework recognising private ODR or arbitration institutions for retail lending disputes could be found or verified. RB-IOS 2026's own settlement facilitation by Deputy Ombudsmen is the regulator's chosen route.

### 8. Collections and recovery conduct

- **Recovery conduct (RE and its agents) [likely – RBI circular "Outsourcing of Financial Services – Responsibilities of regulated entities employing Recovery Agents", 12 Aug 2022, applying to commercial banks, co-operative banks, AIFIs, NBFCs (including HFCs) and ARCs; not re-verified]:**
  - no intimidation or harassment, verbal or physical, against any person;
  - no acts meant to publicly humiliate, or to intrude on the privacy of the debtor's family members, referees and friends;
  - no inappropriate messages on mobile or social media;
  - no threatening or anonymous calls;
  - no persistent calling;
  - **no recovery calls before 8:00 a.m. or after 7:00 p.m.**;
  - no false or misleading representations.
- **Recovery-agent framework (RE) [likely]:**
  - due diligence on agents;
  - a Board-approved policy and code of conduct, which agents undertake to follow;
  - training (for bank agents, IIBF Debt Recovery Agent certification);
  - telling the borrower the agency's details when a case is passed to it;
  - agents carry the RE's notice, authorisation letter and ID;
  - RBI may bar an RE from using recovery agents in an area or entirely.
  - **[unverified]** Whether NBFC agents now need DRA certification.
- **LSP as recovery agent [likely]:** permitted only if the RE appoints it under its outsourcing framework and names it in the KFS, with notice before first contact (§3). The RE stays responsible for the LSP's conduct.
- **Penal charges [likely – RBI "Fair Lending Practice – Penal Charges in Loan Accounts", 18 Aug 2023, effective from 1 Jan 2024 with transition to 1 Apr 2024]:**
  - penal _charges_, not penal interest;
  - no capitalisation or compounding;
  - reasonable and disclosed in the agreement, KFS and website;
  - **reminders must state the applicable penal charges, and every levy must be communicated with its reason.**
- **Outbound calling [unverified]:** RBI told REs in early 2025 to use the TRAI **1600-series** numbers for service and transactional calls and 140-series for promotional calls. Collection calls belong in the service series.
- **Enforcement examples:**
  - **[likely]** In **September 2022** RBI ordered **Mahindra & Mahindra Financial Services** to stop all recovery and repossession through outsourced agents, after a death during a repossession in Hazaribagh, Jharkhand. The order was later lifted.
  - **[likely]** In **October 2024** RBI barred four NBFCs (Asirvad, Arohan, DMI Finance, Navi Finserv) from sanctioning and disbursing loans over pricing and conduct concerns. The bars were later lifted.
  - **[unverified]** Monetary penalties on banks and NBFCs for agents calling outside permitted hours (for example a reported 2023 penalty on a large private bank).
  - **[unverified]** Any 2025–26 RBI action specifically against an LSP for harassment.
- **State law [unverified]:** Karnataka (2025 ordinance/Act on coercive recovery of micro and small loans) and Tamil Nadu (2025) passed anti-coercive-recovery laws with criminal penalties. Separately, the BNS criminalises intimidation, extortion and abetment of suicide. These raise the risk for Udofin field and phone collections.
- **AI in support and collections [likely – RBI FREE-AI Committee report, Aug 2025; recommendations only]:**
  - disclose to customers when they are dealing with AI;
  - give a route to a human;
  - keep Board-approved AI governance and an AI inventory;
  - treat AI-related grievances within the grievance redressal mechanism.
  - Separately, under the DPDP Act 2023 and the DPDP Rules 2025 (notified in November 2025, most obligations phased to about May 2027), data fiduciaries must answer data grievances. The Rules set an outer limit of about 90 days **[likely]**.

### 9. DLG/FLDG versus collection responsibility

**[likely – DLG provisions of the DL Directions 2025, originally the 8 Jun 2023 guidelines]**

- DLG cover is capped at **5% of the loan portfolio**.
- It may take the form of a cash deposit, an FD with lien, or a bank guarantee in the RE's favour.
- It must be invoked within 120 days of overdue status.
- The RE recognises NPAs regardless of DLG.
- An LSP giving DLG must be a company incorporated under the Companies Act.
- **The LSP must publish on its website** the number of portfolios and the amounts on which it has given DLG.

**[interpretation]** DLG is a credit-risk contract between the RE and Udofin. It does not assign the loan, make Udofin a creditor, or authorise Udofin to contact borrowers. Collection is a separate **outsourced recovery-agent mandate** from each RE. Udofin's first-loss stake gives it a direct incentive to collect hard, so the RE should apply stronger oversight: call audits, complaint-rate triggers and kill-switches.

---

## Requirements-to-controls

| ID    | Requirement                                                                                                                                | Source (instrument + para/section if verified)                                | Applies to                                                           | Status                                 | System control in Udofin                                                                                                                                                                                           | Evidence to retain                                     | Test case                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| GR-01 | Borrower must complain to RE first; RE has 30 days (or longer prescribed) before RB-IOS                                                    | RB-IOS 2026, maintainability clause (number not verified); RBI FAQ (Jul 2026) | RE (Udofin as agent)                                                 | Confirmed (FAQ extract)                | Every channel (DLA form, web, email, chat/AI, voice, social, RE hand-off) creates a ticket with a UTC timestamp, RE mapping and a day counter. Udofin receipt = RE receipt.                                        | Immutable ticket log, channel payload, acknowledgement | Raise a grievance in AI chat; ticket ID issued and RE notified the same business day; counter shows day 0 |
| GR-02 | Ombudsman complaint within 90 days of the later of timeline expiry or last RE communication                                                | RB-IOS 2026; RBI FAQ                                                          | Borrower right; RE informs                                           | Confirmed (FAQ extract)                | Final-reply template auto-inserts the cms.rbi.org.in link, the computed 90-day deadline date, the PNO and CRPC details. Reminder at day 60.                                                                        | Final reply PDF and hash, delivery receipt             | Close a ticket; reply must contain the CMS link and correct deadline                                      |
| GR-03 | Not maintainable if same grievance is pending or decided before an arbitrator or other forum                                               | RB-IOS 2026 salient features                                                  | RE/LSP design                                                        | Confirmed (RE-published features)      | Rule engine **blocks any Equator arbitration** referral for retail borrowers. Mediation offer allowed only after the final reply or day 30, with a warning screen.                                                 | Consent artefact, warning screen version               | Try a referral on day 10: blocked. Day 31: mediation-only option with disclosures.                        |
| GR-04 | PNO (≥ GM rank) appointed; PNO, CRPC address and CMS link displayed                                                                        | RB-IOS 2026 RE obligations                                                    | RE                                                                   | Likely                                 | Per-RE master data (PNO, GRO, IO flag, RB-IOS coverage flag) drives the DLA "Grievance" page and KFS                                                                                                               | Versioned page snapshots                               | Each live RE has complete PNO data, otherwise its offers are hidden                                       |
| GR-05 | RB-IOS salient features available on website                                                                                               | RB-IOS 2026                                                                   | RE (Udofin mirrors)                                                  | Likely                                 | Link to each RE's salient features page, plus Udofin's own explainer                                                                                                                                               | Snapshot log                                           | Link check job is green                                                                                   |
| GR-06 | Nodal GRO at RE **and** LSP; details on RE and LSP websites, DLA and KFS; complaint facility on DLA and website                            | DL Directions 2025 (grievance para; number unverified)                        | Both                                                                 | Likely                                 | Udofin Board-appointed nodal GRO; in-app and web complaint forms; KFS template carries Udofin and RE GRO details                                                                                                   | Appointment letter, KFS samples                        | KFS for each RE shows both GROs                                                                           |
| GR-07 | RE keeps responsibility for grievance redressal, including complaints against the LSP                                                      | DL Directions 2025                                                            | RE                                                                   | Likely                                 | Ticket mirrored to RE's system by API within 1 business day. Udofin cannot finally reject RE-owned matters.                                                                                                        | RE acknowledgement ID                                  | RE API down: ticket goes to manual queue and alert fires                                                  |
| GR-08 | Internal Ombudsman review before full or partial rejection (in-scope REs)                                                                  | IO Master Direction 2023 (as consolidated)                                    | RE (NBFC-D ≥10 branches; NBFC-ND ≥₹5,000 cr with customer interface) | Likely                                 | "Proposed rejection" state routed to the RE's IO queue. Reply locked until the IO decision is attached.                                                                                                            | IO decision note                                       | Rejection without an IO record fails                                                                      |
| GR-09 | Disputes heard at least at the next higher level; GRO display                                                                              | NBFC Fair Practices Code (SBR MD 2023, consolidated)                          | RE                                                                   | Likely                                 | Two-level approval for adverse outcomes                                                                                                                                                                            | Approver IDs                                           | Same user cannot draft and approve                                                                        |
| GR-10 | No harassment; calls only 08:00–19:00; no third-party humiliation; no threatening, anonymous or persistent calls; no misleading statements | RBI circular, 12 Aug 2022                                                     | RE and agents (Udofin if appointed)                                  | Likely                                 | Dialer hard-blocks outside 08:00–19:00 borrower local time; daily attempt cap; registered caller IDs only; template library pre-approved by RE; no contact-list data; profanity and threat detection on recordings | Call detail records, recordings, template approvals    | Schedule a call at 19:01: blocked. Fourth attempt in a day: blocked.                                      |
| GR-11 | KFS names the LSP acting as recovery agent; borrower told before agent contact or change                                                   | DL Directions 2025                                                            | RE                                                                   | Likely                                 | KFS field; SMS/email "agent assigned" notice gates the first collection contact                                                                                                                                    | Notice delivery logs                                   | Contact attempted before notice: blocked                                                                  |
| GR-12 | Agent due diligence, code of conduct, training, ID, authorisation letter                                                                   | RBI recovery-agent instructions (banks 2008; NBFC outsourcing)                | RE; agent                                                            | Likely (NBFC certification unverified) | Agent registry (RE authorisation, training certificate, police verification, expiry); agent ID shown in app and in every message                                                                                   | Registry and audits                                    | Expired certificate: agent locked out                                                                     |
| GR-13 | Repayments directly to the RE's account; no LSP pool account                                                                               | DL Directions 2025                                                            | RE/LSP                                                               | Likely                                 | Payment links and mandates created on the RE's merchant or collection account; Udofin never receives funds                                                                                                         | PA settlement reports                                  | Reconciliation shows no Udofin-held funds                                                                 |
| GR-14 | Penal charges disclosed; no capitalisation; reminders state penal charges; each levy communicated with reason                              | RBI Penal Charges circular, 18 Aug 2023                                       | RE                                                                   | Likely                                 | Reminder templates pull penal-charge text from the RE's product configuration; levy event triggers a notice                                                                                                        | Template versions, notices                             | Overdue reminder must include the penal charge text                                                       |
| GR-15 | DLG ≤5%; permitted forms; 120-day invocation; LSP publishes DLG portfolios; DLG ≠ collection right                                         | DL Directions 2025 (DLG)                                                      | RE/LSP                                                               | Likely                                 | DLG ledger kept apart from the collections module; website disclosure page; collections enabled only by a separate RE recovery mandate                                                                             | DLG contracts, disclosures                             | Disable the recovery mandate: collections stop even though DLG is active                                  |
| GR-16 | DLA must not access contacts, call logs or media; camera, mic and location one-time with consent                                           | DL Directions 2025                                                            | LSP/RE                                                               | Likely                                 | Manifest lint in CI; no READ_CONTACTS / READ_CALL_LOG                                                                                                                                                              | Build manifests                                        | CI fails if the permission is added                                                                       |
| GR-17 | Arbitrator independence; no unilateral appointment                                                                                         | A&C Act s.12(5), Seventh Schedule; _CORE_, SC CB, 8 Nov 2024                  | RE/Equator                                                           | Likely                                 | No pre-dispute arbitration clause in retail loan or LSP terms; legal sign-off gate on templates                                                                                                                    | Template register                                      | Clause scanner flags "arbitration" in retail templates                                                    |
| GR-18 | Consumer Commission not ousted                                                                                                             | CPA 2019 s.100; _Emaar MGF v Aftab Singh_                                     | RE/LSP                                                               | Likely                                 | Grievance page lists RB-IOS, Consumer Commission (e-Jagriti) and Lok Adalat                                                                                                                                        | Page snapshot                                          | Copy review                                                                                               |
| GR-19 | Mediation voluntary; online mediation needs written consent; MSA enforceability depends on commencement and MSP status                     | Mediation Act 2023 ss.5, 27, 28, 30                                           | Equator/RE                                                           | Unverified (commencement)              | Separate, unbundled e-consent; "not court-enforceable unless…" wording unless verified                                                                                                                             | Consent records                                        | Consent cannot be pre-ticked or bundled                                                                   |
| GR-20 | No dark patterns                                                                                                                           | CCPA Dark Patterns Guidelines, 30 Nov 2023                                    | Platform (Udofin)                                                    | Likely                                 | UX review checklist; RB-IOS option shown with equal prominence                                                                                                                                                     | Design review record                                   | Accessibility and dark-pattern audit                                                                      |
| GR-21 | AI disclosed; human escalation; AI makes no adverse decisions                                                                              | RBI FREE-AI report, Aug 2025 (recommendations)                                | RE/LSP                                                               | Likely (non-binding)                   | "You are chatting with an AI" banner; "Talk to a person" always visible; complaint-intent classifier creates a ticket; AI cannot close, reject or settle                                                           | Conversation logs                                      | Say "I want to complain": ticket created and human SLA starts                                             |
| GR-22 | Service/transactional calls from the 1600 series                                                                                           | RBI/TRAI 2025 direction                                                       | RE and agents                                                        | Unverified                             | Telephony configuration uses only registered 1600 numbers for collections                                                                                                                                          | Number registry                                        | Outbound from a non-1600 number: blocked                                                                  |
| GR-23 | Data-protection grievances answered                                                                                                        | DPDP Act 2023 s.13; DPDP Rules 2025 (phased)                                  | Data fiduciary (RE/Udofin)                                           | Likely                                 | "Privacy" ticket category routed to the DPO/contact person                                                                                                                                                         | Response logs                                          | Privacy ticket gets the DPO SLA                                                                           |
| GR-24 | Complaint MIS and annual-report disclosure                                                                                                 | NBFC complaint disclosure norms                                               | RE                                                                   | Likely                                 | Monthly per-RE MIS export (volumes, categories, TAT, RB-IOS escalations, harassment flags)                                                                                                                         | MIS files                                              | MIS totals reconcile with ticket DB                                                                       |

---

## Challenges to the owner's plan

1. **"Udofin provides 5% FLDG, therefore Udofin handles collections."** _Problem:_ DLG is a risk-sharing contract with the RE, not a collection right. _Authority:_ DL Directions 2025 (DLG and recovery provisions); recovery-agent instructions (12 Aug 2022); RE outsourcing directions. _Alternative:_ sign a separate **recovery-agent/outsourcing agreement with each RE**, name Udofin as recovery agent in the KFS, follow RE-approved scripts and policies, put repayments only into RE accounts, and give the RE audit rights and a kill-switch. Because Udofin bears first loss, offer stronger safeguards: call recording, complaint-rate triggers, and no field visits without RE approval.
2. **Escalating unresolved grievances to Equator.** _Problem:_ the RE must handle the complaint within 30 days. Equator **arbitration** makes RB-IOS non-maintainable. Equator **mediation** after the final reply uses up the new **90-day** RB-IOS window. _Authority:_ RB-IOS 2026 maintainability and time-limit clauses; DL Directions (RB-IOS escalation). _Alternative:_ the escalation ladder is Udofin GRO → RE GRO/IO → **RB-IOS (CMS)**. Equator appears only as an **optional, parallel, free, mediation-only** choice, offered after the final reply or on day 30, with a visible Ombudsman deadline countdown.
3. **Equator is owned by the same group as Udofin.** _Problem:_ the Schedules treat group companies as "affiliates". Udofin has a first-loss stake. Appointment by an affiliated institution looks like the unilateral appointment barred by _CORE_ (8 Nov 2024) and _Perkins_. _Authority:_ A&C Act s.12(5) and the Fifth and Seventh Schedules. _Alternative:_ for disputes about Udofin-sourced loans, use **non-affiliated** providers, Lok Adalat or court-annexed mediation. If Equator is ever used:
   - an independent appointing authority, or the borrower chooses from a panel Equator has no say in;
   - neutrals with no Udofin or RE relationship and written s.12 disclosures;
   - fees paid by the RE into a flat, outcome-neutral pool;
   - Equator has no access to Udofin data beyond the case file;
   - no Udofin KPIs tied to Equator outcomes;
   - published annual outcome statistics.
4. **Arbitration clauses in retail loan documents.** _Problem:_ after _CORE_ and under s.12(5) they are unenforceable or vulnerable; they do not oust Consumer Commissions (_Emaar_); they may be "unfair contract" terms under CPA 2019 s.2(46). _Alternative:_ no pre-dispute arbitration in retail contracts. Use post-dispute submission agreements only, with independent institutions, the seat at the borrower's district, and costs borne by the RE.
5. **"Without a separate app" (Equator embedded in Udofin).** _Problem:_ it blurs independence and invites dark patterns. _Alternative:_ a separate Equator web flow with its own terms, privacy notice, branding and consent. The Udofin DLA only deep-links to it, never pre-fills a "settlement", and shows RB-IOS with equal prominence.
6. **AI agent answering borrower queries.** _Problem:_ an AI that "deflects" complaints delays the RE's clock, and borrowers may miss the 90-day window. _Authority:_ RB-IOS 2026 (a complaint "in writing or any other mode" counts); DL Directions (complaint facility on the DLA); FREE-AI recommendations. _Alternative:_ the AI must recognise complaint intent and open a ticket immediately; it is disclosed as AI; a person is always reachable; it cannot reject, close, settle, threaten or make legal statements about Equator; it answers loan terms only from the RE's KFS and knowledge base.
7. **"Resolution finance" and "award-enforcement finance" for Equator outcomes.** _Problem:_ financing the outcome of an affiliated ADR, and cross-selling to people in dispute, creates incentive and tying conflicts. _Alternative:_ keep these products away from any Equator matter involving Udofin-sourced loans, require independent RE credit decisions, and give the borrower a conflict disclosure.
8. **Marketing push notifications to delinquent borrowers.** _Problem:_ mixing marketing (for example "debt reset" offers) with collections pressure risks misleading or coercive messaging. _Alternative:_ separate collections and marketing channels and consents; no marketing to accounts in active collections without RE approval.
9. **Payments through Udofin-owned Razorpay, Stripe or PayPal accounts.** _Problem:_ the DL Directions bar LSP pass-through or pool accounts for repayments. _Alternative:_ collect only into RE-owned merchant accounts. Other workstreams cover provider feasibility.
10. **Phone permissions used for collections (location, contacts).** _Problem:_ the DL Directions ban contact-list and call-log access, and Google Play's personal-loan policy also restricts these. _Alternative:_ no contacts permission; location only once for KYC, never for tracing.

---

## Open questions

1. The exact RB-IOS 2026 clause text and numbers: the NBFC asset threshold (is ₹100 crore retained?), HFC coverage, and the exact "forum" wording, i.e. whether "other forum" covers private mediation. Get the RBI PDF and have counsel review it.
2. The content of the **28 Nov 2025** consolidated directions (reportedly function-wise "Responsible Business Conduct" directions per RE type) and any **31 Jul 2026** directions or amendments. Did they renumber or change the GRO, IO, recovery-agent, DLG or DL grievance provisions? **Not verified.**
3. The Mediation Act 2023 commencement status as at Oct 2026, whether the Mediation Council of India exists, and whether Equator is or can be a recognised MSP.
4. Whether RBI issued revised recovery-agent or "recovery practices" directions in 2025–26, including NBFC agent certification.
5. Which partner REs are inside RB-IOS and which have an Internal Ombudsman. This decides workflow branches and whether to onboard them at all.
6. Equator's corporate structure, governance and fee model, and whether any partner RE would accept it.
7. Business decision: will Udofin act as recovery agent at all, or leave collections to the REs and their agencies?
8. Record retention for complaint evidence: reconcile RE retention policies, the DL Directions' minimal-data rule for LSPs, and DPDP erasure.
9. State anti-coercive-recovery laws (Karnataka, Tamil Nadu and others) in launch states.

---

## Recommended compliant design

**A. Complaint lifecycle (state machine)**

- **States:** `RECEIVED → ACKNOWLEDGED → TRIAGED → ASSIGNED(Udofin|RE) → INVESTIGATING → PROPOSED_RESOLUTION → [IO_REVIEW] → FINAL_REPLY_SENT → CLOSED`. Side states: `REOPENED`, `RBIOS_FILED` (when the RE's PNO is notified), `MEDIATION_OFFERED` and `MEDIATION_DECLINED/ACCEPTED`.
- **Clock:** starts at Udofin receipt, which is treated as RE receipt.
- **Acknowledgement** within 1 hour automatically, with the ticket ID, RE name and expected date.
- **Triage** within 1 business day. P1 cases (harassment, threats, suicide risk, fraud) get **collections frozen on the account within 2 hours** pending review, plus human callback.
- **Hand-off to the RE** within 1 business day for RE-owned matters.
- **Escalation:** automatic to the RE GRO on day 10, and to the RE PNO/IO on day 20.
- **Final reply by day 25 at the latest.** It contains the RB-IOS text, the CMS link, the computed 90-day deadline, the PNO and CRPC details, and Consumer Commission information.
- **Ombudsman-ready dossier:** a one-tap download of the ticket ID, dates, correspondence and final reply, to pass the CMS maintainability checks.
- **Evidence:** append-only audit log, call recordings with notice, agent IDs, template versions, DLG status and ledger snapshots, all held as the RE's processor.

**B. AI-assisted support limits**

- Disclosed as AI and labelled in every message.
- The complaint-intent classifier opens a ticket (it never "resolves").
- A person is reachable in-session.
- Answers only from the RE-approved KFS and knowledge base; no legal advice; neutral about every forum.
- No adverse decisions, settlements or collection threats.
- AI collection voice bots follow GR-10 (hours, caps, identification) and never impersonate a person.
- Distress detection hands over to a person and shows helpline information.
- Logs kept and sampled for QA; Board-approved AI policy.

**C. Referral to Equator**

- **When:** only after the final reply or the 30-day lapse, and never as a precondition.
- **What:** **mediation only** for retail borrowers; no arbitration unless the borrower, after the dispute and with independent advice, chooses it, accepting in a separate document that RB-IOS will then be barred.
- **Consent:** unbundled, revocable and timestamped.
- **Conflict disclosure:** a plain-language statement of the common ownership and Udofin's DLG interest.
- **Fees:** zero for the borrower; paid by the RE as flat fees not tied to outcome.
- **Neutrals:** appointed independently, with s.12 disclosures.
- **Deadline protection:** a countdown to the RB-IOS deadline throughout, with a 15-day warning, and Equator must close or report within 45 days.
- **During mediation:** collections paused for the disputed amount, subject to RE policy, and accurate CIC reporting.
- **Settlement agreement:** a 7-day withdrawal window, and no clause gagging regulatory complaints.
- **Alternatives** shown alongside: Lok Adalat, Consumer Commission, RB-IOS.

---

## Self-verification

| #   | Claim                                                              | Verdict                                                                  | Basis / correction                                       |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| 1   | RB-IOS 2026 issued 16 Jan 2026, effective 1 Jul 2026, repeals 2021 | **Confirmed** (search extracts of RBI press release and SBI-hosted text) | Kept                                                     |
| 2   | Draft issued 7 Oct 2025                                            | Could not verify primary; secondary only                                 | Marked [likely]                                          |
| 3   | 30-day (or longer prescribed) RE reply before Ombudsman            | **Confirmed** (RBI FAQ extract)                                          | Kept                                                     |
| 4   | 90-day window to approach the Ombudsman                            | **Confirmed** (RBI FAQ extract); one secondary source says "1 year"      | Body says 90 days and notes the conflict                 |
| 5   | Compensation ₹30 lakh / ₹3 lakh                                    | Several secondary sources agree; primary not opened                      | Marked [likely]                                          |
| 6   | Arbitrator/other-forum bar                                         | **Confirmed** (RE-published salient features)                            | Kept; private-mediation coverage marked [interpretation] |
| 7   | PNO ≥ GM rank; CRPC/CMS display duties                             | Secondary/search extract                                                 | Marked [likely]                                          |
| 8   | Recovery calls 08:00–19:00 (12 Aug 2022 circular)                  | Could not verify this session (fetch blocked)                            | Marked [likely]                                          |
| 9   | _CORE_ date 8 Nov 2024 and holdings                                | Could not verify online                                                  | Marked [likely]; holdings paraphrased                    |
| 10  | Mediation Act core provisions not in force                         | Could not verify for Oct 2026                                            | Marked [unverified]; listed in Open questions            |
| 11  | DLG cap 5%, 120-day invocation, website disclosure                 | Could not verify online                                                  | Marked [likely]                                          |
| 12  | IO thresholds (NBFC-D ≥10 branches; NBFC-ND ≥₹5,000 cr)            | Could not verify online                                                  | Marked [likely]                                          |

---

## Sources

Primary or quasi-primary sources were reached only through search extracts. Fetching was blocked.

- [RBI Press Release – Reserve Bank – Integrated Ombudsman Scheme, 2026](https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=62052) – 16 Jan 2026 – primary (search extract only)
- [RBI – RB-IOS 2026 scheme PDF](https://rbidocs.rbi.org.in/rdocs/content/pdfs/SCHEME16012026_A.pdf) – 16 Jan 2026 – primary (fetch blocked)
- [RBI – FAQs on RB-IOS 2026](https://www.rbi.org.in/commonman/Upload/English/FAQs/PDFs/RBIOS01072026.pdf) – Jul 2026 – primary (search extract)
- [SBI-hosted RB-IOS 2026 text](https://sbi.bank.in/documents/136/1364568/Reserve+Bank+Integrated+Ombudsman+Scheme+2026.pdf/f7e84648-b034-bf5d-95f9-76a4d3ef9a4a?t=1783668512462) – 2026 – RE copy of primary
- [Axis Bank – Salient Features RB-IOS 2026](https://application.axis.bank.in/docs/Salient_Features_Integrated_Scheme_2026.pdf) – 2026 – RE-published
- [Navi – Salient Features RB-IOS 2026](https://public-assets.prod.navi-tech.in/navi-website-assests/documents/Salient_Features_Integrated_Ombudsman_Scheme_2026_20260630194008.pdf) – 30 Jun 2026 – RE-published
- [AU Small Finance Bank – RB-IOS 2026](https://www.au.bank.in/ta/notice-board-language/integrated-ombudsman-scheme-2021-salient-features/English.pdf) – 2026 – RE-published
- [Credila – Salient Features RB-IOS 2026](<https://www.credila.com/pdfs/Salient-Features-RBI-IO-Scheme-2026-(2).pdf>) – 2026 – RE-published
- [Piramal Finance – Salient Features](https://www.piramalfinance.com/content/dam/piramalfinance/pdf/stakeholder/salient-features/pfl-salient-features-english.pdf) – 2026 – RE-published
- [Standard Chartered India – RB-IOS 2026](https://www.sc.bank.in/important-information/client-experience/banking-ombudsman/) – 2026 – RE-published
- [Vinod Kothari – RB-IOS 2026 key changes](https://vinodkothari.com/2026/01/rbi-integrated-ombudsman-scheme-2026-key-changes/) – Jan 2026 – secondary
- [Candour Legal – RB-IOS 2026](https://candourlegal.com/rbi-integrated-ombudsman-scheme-2026-banks-nbfc-customers/) – Jul 2026 – secondary
- [Business Standard – Ombudsman timelines](https://www.business-standard.com/finance/personal-finance/rbi-ombudsman-scheme-know-complaint-timelines-compensation-appeal-rules-126070800754_1.html) – 8 Jul 2026 – secondary
- [Business Standard – co-op banks brought under ombudsman (draft)](https://www.business-standard.com/finance/news/central-state-co-op-banks-brought-under-ambit-of-rbi-s-ombudsman-scheme-125100701358_1.html) – 7 Oct 2025 – secondary
- [BusinessToday – RBI revamps grievance redressal](https://www.businesstoday.in/personal-finance/banking/story/rbi-revamps-customer-grievance-redressal-heres-what-changes-for-bank-nbfc-customers-541259-2026-07-06) – 6 Jul 2026 – secondary
- [Upstox – RB-IOS 2026 explainer](https://upstox.com/news/business-news/financial-regulations/explainer-rbi-notifies-integrated-ombudsman-scheme-2026-who-can-complain-and-how/article-187895/) – 2026 – secondary
- [AffairsCloud – RB-IOS 2026](https://affairscloud.com/rbi-issues-reserve-bank-integrated-ombudsman-scheme-rb-ios-2026-to-simplify-complaint-resolution/) – Jan 2026 – secondary
- [VisionIAS – RB-IOS 2026](https://visionias.in/current-affairs/news-today/2026-01-17/economy/reserve-bank-of-india-rbi-issued-reserve-bank-integrated-ombudsman-scheme-rb-ios-2026) – 17 Jan 2026 – secondary
- Instruments cited from the researcher's knowledge, with no URL verified this session (**unverified**):
  - RBI (Digital Lending) Directions, 2025 (8 May 2025)
  - RBI circular on recovery agents (12 Aug 2022)
  - Master Direction – Internal Ombudsman for REs (29 Dec 2023)
  - Penal Charges circular (18 Aug 2023)
  - NBFC SBR Master Direction / FPC (19 Oct 2023)
  - Mediation Act 2023 and notification of 9 Oct 2023
  - Arbitration and Conciliation Act 1996 (s.12(5), Fifth and Seventh Schedules)
  - _CORE v ECI-SPIC-SMO-MCML_ (SC, 8 Nov 2024)
  - _Emaar MGF v Aftab Singh_ (SC, 2018)
  - Consumer Protection Act 2019
  - Legal Services Authorities Act 1987
  - NITI Aayog ODR Policy Plan (Nov 2021)
  - CCPA Dark Patterns Guidelines (30 Nov 2023)
  - RBI FREE-AI Committee report (Aug 2025)
  - DPDP Act 2023 and DPDP Rules 2025
