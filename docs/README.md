# AG Shop Pro — Documentation

The complete documentation package for **AG Shop Pro**, a multi-tenant auto-repair-shop
management platform. Every document here was written from the actual repository source and
verified with the Graphify knowledge graph; where behaviour could not be confirmed from
the code it is explicitly marked **UNVERIFIED**.

> **New here? Start with [PRODUCT_OVERVIEW.md](PRODUCT_OVERVIEW.md).**

## The documents

| Document | What it contains | Primary audience | Type |
|---|---|---|---|
| [PRODUCT_OVERVIEW.md](PRODUCT_OVERVIEW.md) | What the product is, roles, modules, the full repair workflow, tenant isolation, deployment model, what is/isn't supported, an end-to-end data walkthrough, glossary | Everyone | User-facing |
| [USER_MANUAL.md](USER_MANUAL.md) | How to use every page and control, organized by role, with step-by-step procedures and common errors | Shop staff & customers | User-facing |
| [FEATURE_REFERENCE.md](FEATURE_REFERENCE.md) | Feature-by-feature catalog with pages, routes, tables, rules, tests, and a **status label** (functional / limited / placeholder / not implemented) | Product, QA, support, devs | Reference |
| [TECHNICAL_ARCHITECTURE.md](TECHNICAL_ARCHITECTURE.md) | Repo structure, request lifecycle, DB schema, auth/roles/tenancy, the **complete API reference**, migrations, testing, how-to recipes, Graphify usage, tech debt | Developers | Technical |
| [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) | Production architecture, deploy/rollback, migrations, health, PM2/Nginx, logs, backup/restore, secret rotation, incident response, troubleshooting | DevOps, admins, support | Operational |
| [PILOT_ONBOARDING.md](PILOT_ONBOARDING.md) | Pilot scope, responsibilities, setup, training, support, limitations, success/exit criteria, launch checklist | Pilot shops & coordinators | User-facing |
| [TRAINING_WALKTHROUGH.md](TRAINING_WALKTHROUGH.md) | A guided, 19-step live demo from sign-in to portal feedback, with role/expected-result/mistake notes | Trainers & new users | User-facing |
| [FAQ_TROUBLESHOOTING.md](FAQ_TROUBLESHOOTING.md) | Symptom → cause → user fix → admin fix → escalate, by category | Users & support | Operational |
| [MANUAL_ACTIONS_CHECKLIST.md](MANUAL_ACTIONS_CHECKLIST.md) | Everything that must be done **by hand** (infra, secrets, data, acceptance), in phases, with evidence tracking and blocking flags | Owners, admins, DevOps, coordinators | Operational |

## Recommended reading order

1. **[PRODUCT_OVERVIEW.md](PRODUCT_OVERVIEW.md)** — orient yourself.
2. Then by who you are:
   - **Shop staff / customers:** [USER_MANUAL.md](USER_MANUAL.md) →
     [TRAINING_WALKTHROUGH.md](TRAINING_WALKTHROUGH.md) →
     [FAQ_TROUBLESHOOTING.md](FAQ_TROUBLESHOOTING.md).
   - **Developers:** [TECHNICAL_ARCHITECTURE.md](TECHNICAL_ARCHITECTURE.md) →
     [FEATURE_REFERENCE.md](FEATURE_REFERENCE.md).
   - **DevOps / admins / support:** [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) →
     [MANUAL_ACTIONS_CHECKLIST.md](MANUAL_ACTIONS_CHECKLIST.md) →
     [FAQ_TROUBLESHOOTING.md](FAQ_TROUBLESHOOTING.md).
   - **Pilot coordinators:** [PILOT_ONBOARDING.md](PILOT_ONBOARDING.md) →
     [MANUAL_ACTIONS_CHECKLIST.md](MANUAL_ACTIONS_CHECKLIST.md) →
     [TRAINING_WALKTHROUGH.md](TRAINING_WALKTHROUGH.md).
   - **Product / QA:** [FEATURE_REFERENCE.md](FEATURE_REFERENCE.md) →
     [PRODUCT_OVERVIEW.md](PRODUCT_OVERVIEW.md).

## Which documents are operational vs user-facing

- **Operational:** OPERATIONS_RUNBOOK, MANUAL_ACTIONS_CHECKLIST, FAQ_TROUBLESHOOTING.
- **User-facing:** PRODUCT_OVERVIEW, USER_MANUAL, PILOT_ONBOARDING, TRAINING_WALKTHROUGH.
- **Reference/technical:** FEATURE_REFERENCE, TECHNICAL_ARCHITECTURE.

## Must be reviewed before pilot launch

Read and complete these before any shop goes live:

- [MANUAL_ACTIONS_CHECKLIST.md](MANUAL_ACTIONS_CHECKLIST.md) — **the gating checklist**
  (see its "blocking items required BEFORE pilot" summary).
- [PILOT_ONBOARDING.md](PILOT_ONBOARDING.md) — scope, exclusions, launch checklist.
- [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) §§5–9, 14 — secrets, deploy, migrations,
  health, backups.
- [FEATURE_REFERENCE.md](FEATURE_REFERENCE.md) §18 — approve the known limitations.

## Where the manual checklist is

Everything that cannot be done or verified from the repository alone lives in
**[MANUAL_ACTIONS_CHECKLIST.md](MANUAL_ACTIONS_CHECKLIST.md)** — organized into six phases
(before pilot, shop setup, training & acceptance, production verification, pilot
operations, pilot completion), with owner, evidence, and blocking flags per item.

## Important truth-in-documentation notes

These are verified facts that override older or in-app content:

- **The app is browser-only** (no mobile apps) and covers the operational core of a shop.
  It does **not** do payments/invoicing, SMS, or live third-party integrations
  (Mitchell 1 is a read-only status placeholder; Square/Twilio/CCC One/Worldpac are not
  built).
- **`public/docs.html` is a static help/marketing page that describes several features
  that do not exist.** Treat [USER_MANUAL.md](USER_MANUAL.md) and
  [FEATURE_REFERENCE.md](FEATURE_REFERENCE.md) as authoritative, not `docs.html`.
- **`KNOWLEDGE_TRANSFER.md` (repo root) is a historical narrative** and is partly out of
  date (it calls the migration/test/lint scripts "placeholders" — they are now real).
  See [OPERATIONS_RUNBOOK.md §26](OPERATIONS_RUNBOOK.md).
- **Shop owners are `manager`s, never `super_admin`.** `super_admin` is AG platform staff
  only (the cross-tenant role). Migration `008` enforces this retroactively.

## How this documentation should be maintained

- **Source of truth is the code.** When code changes, update the affected doc(s) in the
  same pull request (AGENTS.md already asks for screenshots on `public/` changes — extend
  that to doc updates).
- **Re-verify with Graphify** when navigating a change:
  `/graphify . --update` to refresh the graph, then
  `/graphify query "…"` to trace impact. The graph lives in `graphify-out/`.
- **Keep the API reference and permission matrix in sync** with `api/server.js`
  (routes + `requireAuth([...])`) and the schema in sync with `api/migrations/`.
- **Update the Manual Actions Checklist** as infrastructure facts get confirmed (replace
  each **UNVERIFIED** with evidence).
- **Review cadence:** see the table below.

### Suggested ownership & review schedule

| Document | Suggested owner | Review cadence |
|---|---|---|
| PRODUCT_OVERVIEW | Product owner | Each release / quarterly |
| USER_MANUAL | Product + support | On any UI/role change |
| FEATURE_REFERENCE | Product + QA | Each release |
| TECHNICAL_ARCHITECTURE | Lead developer | On schema/API change |
| OPERATIONS_RUNBOOK | DevOps | On infra change / quarterly |
| PILOT_ONBOARDING | Pilot coordinator | Per pilot cohort |
| TRAINING_WALKTHROUGH | Trainer | On UI change |
| FAQ_TROUBLESHOOTING | Support | Monthly during pilot |
| MANUAL_ACTIONS_CHECKLIST | Pilot coordinator + DevOps | Per pilot + as items verified |

---

*Generated from the AG Shop Pro repository (`staging` branch) using the Graphify knowledge
graph for navigation and the source code as the authority. Terminology is consistent
across all documents; see the glossary in [PRODUCT_OVERVIEW.md §14](PRODUCT_OVERVIEW.md).*
