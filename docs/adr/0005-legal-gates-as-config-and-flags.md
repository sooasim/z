# ADR-0005 — Legal/business gates as effective-dated configuration and feature flags

- Status: Accepted · Date: 2026-10-07 · Modules: STAY-03, EXCH-01, GUIDE-01, TRAVEL-01, JET-01, FIN-03, PLAT-06
- Invariants: 7, 8 · Gate: G9

## Context
Whether a property may take paid bookings (숙박업 registration/permits by type and region), how Home Exchange is
classified, which guides may be paid, whether JETPOOL is merchant of record for travel products, tax/fee/payout
rules, and whether charter flights are content-only or transactional are **legal and business decisions** that
differ by jurisdiction and change over time. Hard-coding a guess is both a legal risk and a rewrite risk.

## Decision
- Rules are **data**: `compliance_rules` (property type × jurisdiction predicates, required permits),
  `finance_rules` (fees/taxes/evidence, effective-dated, versioned; historical transactions keep the version they
  used), exchange/guide eligibility policies. Code evaluates predicates; it does not encode the law.
- Capabilities that depend on unresolved decisions ship **behind feature flags, default OFF**:
  `stay.paid_booking`, `exchange.enabled`, `guide.paid`, `travel.commerce`, `charter.direct_booking`,
  `payout.automatic`, `ai.assistant`, `ai.recommendations`, `integrations.pms`.
- Turning a flag ON in production requires the G9 sign-off (legal + business owner) recorded in the release ticket;
  flag changes are AAL2-gated and audited (`config.changed`).
- The release report always lists G9 as **REQUIRES HUMAN APPROVAL**.

## Consequences
- + Deployments are decoupled from legal launch decisions; kill switches exist for incidents.
- + Rule changes are auditable and non-retroactive.
- − Ops must maintain rule data; admin UIs for rules are part of OPS-02.
- Stop condition (AGENTS_MASTER): if a required decision is unresolved, the feature stays OFF and the build
  continues; nobody "temporarily" hard-codes a rule.
