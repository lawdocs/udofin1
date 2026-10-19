# ADR-0019: AI usage boundaries

- **Status:** Proposed — no AI feature exists yet; the AI provider and hosting are an open owner decision
- **Date:** 2026-10-10
- **Related:** ADR-0009, ADR-0010, ADR-0013, ADR-0018

## Context

- The owner's plan includes an AI agent answering borrower queries, and AI help for staff.
- RBI's FREE-AI (Framework for Responsible and Ethical Enablement of AI) committee report, August 2025, recommends among other things a board-approved AI policy and inventory, model-risk management, AI incident reporting, and telling customers when they deal with AI, with a path to a human and grievance redress. It is a committee report, not a binding direction; whether binding AI directions followed is unverified (likely, `docs/research/2026-10-10/privacy-security-outsourcing.md` §10; GR-21 "likely (non-binding)").
- The grievance route must reach named human grievance officers; nothing an AI says may be misleading; an AI cannot replace or delay the Ombudsman path (research interpretation, `rbi-digital-lending.md` challenge 9; `grievance-adr-collections.md`).
- Borrower personal data sent to an offshore LLM API is processing outside India, which conflicts with the reported India-storage rule unless deleted and brought back within 24 hours (research labels in ADR-0010).
- Amazon Bedrock "India geo" cross-Region inference processes Claude and OpenAI models within Mumbai and Hyderabad (confirmed, AWS announcements Aug/Sep 2026, `infra-stack.md` §11).
- The credit decision belongs to the lender (ADR-0006, ADR-0015).

## Decision

1. **Assistive only.** Allowed uses:
   - answering from **approved** FAQ and product content (retrieval; content approved by Udofin and, for lender-specific content, by that lender);
   - read-only status lookup for the authenticated borrower's own applications, loans and tickets;
   - classifying messages (for example detecting a complaint);
   - drafting replies for staff, which a human reviews and sends.
2. **Never:** reject, approve, price or otherwise decide credit; settle, close or reject a complaint; threaten or pressure; give personalised financial advice outside approved scripts; change any record; act on payments.
3. **Always:** identify itself as AI at the start of every conversation; offer a human hand-off at every turn; **open a complaint ticket** whenever a complaint is expressed (ADR-0018) and say so.
4. **Residency:** inference runs India-hosted (for example Bedrock India geo cross-Region inference), or prompts are stripped of personal data before any call outside India. No direct calls to offshore LLM APIs with borrower data.
5. **Records:** transcripts are kept as records in India, linked to the borrower and any ticket; retention period to be decided with the records policy. AI actions are audited (ADR-0013).
6. **Governance:** an AI register (use, model, version, owner), evaluation and red-team results before each release, and AI incident logging, following the FREE-AI recommendations as good practice.
7. **Provider wiring** goes through a port in `packages/adapters` (capability `ai_inference`), subject to the environment guard (mocks in tests; no live provider outside production).
8. **Voice / microphone** is out of scope until legal review: RBI allows microphone access only once for onboarding/KYC (research interpretation), and the mobile app blocks RECORD_AUDIO (ADR-0016).
9. Group products follow the same boundary: an AI must not decide disputes (relevant to Equator AI; `ecosystem-sites.md` §4, interpretation).

## Alternatives considered

| Option                                                    | Why rejected                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No AI at all                                              | Possible, and safest; rejected for now because retrieval-based FAQ and status answers can reduce support load without making decisions. Remains the fallback. |
| Offshore LLM API with a zero-retention contract           | Still processing outside India; relies on the 24-hour rule, whose primary text and scope are unverified. Not the default.                                     |
| Autonomous agent able to act (cancel, reschedule, settle) | Conduct and liability risk; conflicts with human-decision and grievance rules.                                                                                |
| Self-hosted open-weight model in ap-south-1               | Viable for residency, but higher operating cost and evaluation burden for a small team; can be reconsidered.                                                  |

## Consequences

**Positive**

- Lower support load for routine questions while decisions stay with humans and lenders.
- Complaints raised in chat are captured, not lost.

**Negative**

- Narrow usefulness by design; answers limited to approved content.
- Content approval per lender adds work; cost and latency of inference.

**Risks**

- Hallucinated or misleading answers. Mitigation: retrieval from approved content only, refusal outside scope, evaluation sets.
- Prompt injection through borrower messages or documents. Mitigation: no tools that change state; output filtering; red-team tests.
- Personal data leaking into prompts sent outside India. Mitigation: India-hosted inference and egress controls.

## Compliance and security notes

- FREE-AI is non-binding (likely); lenders may still apply it to vendors. RBI device-permission, grievance and India-storage rules apply (labels in ADR-0010, ADR-0016, ADR-0018). Primary-source verification gate applies (README).

## Verification

Planned:

- Saying "I want to complain" creates a ticket and starts the human SLA (research GR-21).
- An egress firewall blocks LLM endpoints other than the approved India-hosted ones (research INF-14).
- Evaluation set: out-of-scope questions are refused; no answer contains credit decisions or threats; the AI disclosure and human hand-off appear in every conversation.
- Transcript retention and residency checked in the data inventory.

## Revisit triggers

- RBI issues binding AI directions, or primary-text review of FREE-AI.
- Owner chooses the AI provider and hosting.
- DPDP substantive obligations commence.
- Any AI incident or borrower complaint about AI answers.
