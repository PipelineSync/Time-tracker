# SolarOps Agent — product ideation brief

**Working thesis:** build the operating system and agent layer for a solar EPC, not another chatbot. The product should keep every lead, design revision, permit, inspection, purchase order, crew visit, customer message, and service event moving toward the next billable milestone — while making safety-critical and legally accountable decisions explicit human approvals.

**Date of this brief:** September 12, 2026  
**Initial market assumption:** US residential and small commercial solar + storage installers doing roughly 10–200 projects per month. The model can be localized later, but permitting, utility, code, financing, and incentive rules make a single global launch a trap.

---

## 1. The product in one sentence

> **SolarOps Agent is a human-supervised digital operations team that takes a solar project from lead to PTO, and then from PTO through monitoring and warranty, using the installer’s existing systems as tools.**

The customer should not have to replace their CRM, design platform, accounting package, monitoring portals, or field app on day one. SolarOps becomes the orchestration and exception-management layer above them, with a normalized project record and an audit trail.

### What it is not

- Not a generic chat window bolted onto a CRM.
- Not a promise that an LLM can replace a licensed engineer, electrician, AHJ, utility, or safety program.
- Not a design engine that should invent electrical values or silently override manufacturer data.
- Not an unattended browser bot that can submit a permit, sign a contract, energize a system, or issue a refund without a policy-controlled approval.

### The wedge I would choose

Start with **post-sale project operations: sold job → engineering QA → permit/interconnection → install scheduling**. This is where a signed deal becomes cash, where delays are measurable, and where information is already distributed across tools. Sales automation is valuable, but many vendors already compete there; a reliable project control plane can create the data and workflow advantage that makes later sales and service automation better.

---

## 2. The user experience: an operations command center

The primary interface is a queue, not a chat transcript.

### Home screen

- **Projects at risk:** the five jobs most likely to miss an install, inspection, PTO, or cash milestone.
- **Agent work completed:** e.g. “matched utility account,” “drafted plan-set correction,” “requested missing structural photo.”
- **Approvals waiting:** grouped by risk, dollar value, and deadline.
- **Exceptions:** “AHJ portal changed,” “design revision conflicts with sold proposal,” “crew photo does not prove required attachment,” “battery model unavailable.”
- **Today:** site visits, inspections, permit payments, customer commitments, overdue follow-ups, and weather alerts.
- **Natural-language command bar:** “Show me every project in Austin waiting on utility approval for more than 10 business days.” The answer must link to the source records and calculations, not just produce prose.

### Project page

Every project has one chronological timeline with:

1. source event and timestamp;
2. agent action and tool used;
3. extracted facts with confidence and source document/page;
4. proposed next action;
5. required approver and policy reason;
6. resulting status or exception.

A project should be understandable by a new operations manager in under two minutes. No important state may live only inside a model context window.

---

## 3. The digital team: specialized agents with one orchestrator

Use a small set of named agents, each with a narrow tool set and explicit success criteria. The orchestrator assigns work; it does not get unrestricted access to every system.

| Agent | Owns | High-value automations | Human boundary |
|---|---|---|---|
| **Concierge** | inbound lead and customer communication | answer FAQs, qualify, collect address/utility bill, book appointments, missed-call text-back, multilingual follow-up | no binding savings promise, credit decision, or contract representation |
| **Deal Desk** | sales hygiene and economics | lead scoring, next-best action, proposal follow-up, financing packet completeness, commission/margin checks | price floors, incentive assumptions, financing terms, and contract send |
| **Survey & Design** | site data and design drafts | address/imagery enrichment, bill OCR, preliminary layout, production scenarios, BOM draft, design-to-sold comparison | final system design, structural/electrical signoff, nonstandard roof/equipment decisions |
| **Engineering QA** | technical consistency and code checks | run deterministic rules, compare revisions, check equipment compatibility, flag missing calculations, prepare plan-set redlines | licensed engineer or authorized designer approval; code interpretation in ambiguous cases |
| **Permit Clerk** | AHJ and utility workflow | jurisdiction lookup, eligibility checks, form filling, document assembly, submission/status polling, correction-letter parsing | payment, attestation, permit submission where required, response to novel AHJ requests |
| **Procurement** | equipment and material readiness | translate approved BOM to purchase plan, compare inventory/lead times, reserve stock, detect substitutions, surface margin impact | purchase orders above threshold, substitutions, backorders, cancellation fees |
| **Dispatch** | scheduling and capacity | crew matching, route and duration estimates, weather-aware planning, customer reminders, inspection booking | schedule changes with customer/crew impact; safety or qualification override |
| **Field Copilot** | install, inspection, and evidence | offline checklist, voice notes, photo labeling, visual QA, missing-evidence detection, as-built comparison, daily report | safety decisions, live electrical work, signoff, change orders, closeout acceptance |
| **Service NOC** | monitoring and warranty | anomaly detection, alert deduplication, remote triage, customer explanation, warranty packet, dispatch recommendation | system shutdown, warranty eligibility decision, replacement authorization |
| **Finance & RevRec** | project cash and profitability | invoice/draw creation, funding packet check, commissions, job-cost variance, aged receivables, PTO-to-final-payment trigger | money movement, write-offs, refunds, tax/accounting policy |
| **Account Manager** | customer relationship after sale | proactive updates, education, review requests, referral prompts, renewal/expansion opportunities | regulated claims, complaint resolution, goodwill credits |

**Important design choice:** an “agent” is a workflow worker with tools, permissions, policies, memory, and evaluation tests — not a persona with broad access. Each action should be replayable and attributable.

---

## 4. End-to-end workflow and automation potential

### A. Lead → qualified appointment

**Automate now**

- Capture web, phone, SMS, ad, partner, and referral leads into one record.
- Respond in seconds with a transparent AI disclosure and opt-out.
- Normalize address, ownership/contact data, utility territory, roof imagery availability, and service territory.
- Read utility bills with OCR/document AI; extract account number, tariff, usage, demand, and billing period with page-level citations.
- Ask a conversational qualification flow: goals, budget/timeline, roof/ground mount, battery/backup, HOA, recent bills, preferred contact.
- Detect duplicates, spam, and impossible service addresses.
- Route high-intent or complex leads to a human; book the right appointment type.

**Assist with approval**

- Preliminary roof feasibility and shade estimate.
- Initial system-size range and expected production range.
- Financing/product recommendation.
- Lead score and expected gross margin.

**Do not autopilot**

- Guarantee savings, tax credits, payback, roof life, or utility approval.
- Represent that a company is licensed in a jurisdiction without verifying the license.

### B. Discovery → proposal → signed agreement

- Generate a discovery brief before the appointment.
- Turn call transcripts into structured facts and unanswered questions.
- Produce design/proposal variants: lowest upfront cost, highest offset, battery/backup, or cash-flow optimized.
- Explain assumptions in plain language and show sensitivity ranges rather than false precision.
- Run proposal QA: name/address consistency, system size, equipment, production, price, incentives, financing, exclusions, and cancellation language.
- Schedule multi-channel follow-up based on customer consent and stated buying timeline.
- On signature, create the project shell, lock the sold scope, request missing documents, and send the customer a clear “what happens next” page.

**Approval gates:** final design selection, price/discount, financing product, contract issuance, and any change to sold scope.

### C. Sold job → survey and engineering

- Create a survey plan from the sold scope and risk profile.
- Give the field tech a personalized checklist: roof, attic, main service, meter, grounding, obstructions, equipment location, internet, battery clearances, structural evidence.
- Accept photos, video, measurements, voice notes, and utility documents offline.
- Use computer vision to label components and flag likely missing/contradictory evidence; show the evidence, not just “AI passed.”
- Draft a system in the selected design platform or import the design and compare it to sold assumptions.
- Generate equipment/BOM candidates from approved catalogs and manufacturer documents.
- Run deterministic validations: DC/AC ratios, voltage/current windows, conductor/OCPD constraints, service/bus limits, battery compatibility, rapid shutdown, setbacks, roof plane and attachment counts, and jurisdiction-specific requirements.
- Produce a design QA packet containing inputs, calculations, source documents, warnings, unresolved questions, and proposed disposition.

**Approval gates:** final design, engineering exception, structural/electrical signoff, and any customer change order.

### D. Permitting and interconnection

- Resolve the AHJ, utility, incentive program, and submittal path from the service address.
- Maintain a jurisdiction playbook: forms, required attachments, fees, plan templates, portal URL, expected turnaround, inspection rules, and known quirks.
- Determine whether the project qualifies for an automated pathway such as SolarAPP+; if not, select the correct manual workflow.
- Assemble permit and interconnection packets from the approved revision.
- Fill web forms through an API where available; use browser automation only in a controlled, observable session when allowed by the portal terms.
- Submit only after a policy gate confirms identity, license, payment, attestations, and approved documents.
- Poll APIs/portals, parse status changes and correction letters, open work items, draft responses, and notify the customer without exposing internal blame.
- Link every submitted artifact to the exact design revision and checksum.

The product should treat permitting as a **state machine with evidence**, not as a text-generation task:

`not-ready → package-drafting → QA → approval-needed → submitted → correction-needed → resubmitted → approved → inspection-scheduled → passed`

The same pattern applies to utility interconnection and incentive claims.

### E. Procurement and install readiness

- Convert the approved BOM into a procurement plan.
- Match items to warehouse stock, supplier availability, serial/batch constraints, price books, and crew capability.
- Detect a substitution before it reaches the field; recompute design/permit/customer implications.
- Create a readiness score that requires: approved design, approved permit, interconnection status, equipment available, customer access confirmed, crew qualified, weather acceptable, and inspection plan.
- Send a customer-facing schedule only when the readiness policy is satisfied.
- Re-plan automatically when a permit, shipment, crew, or weather event changes, but ask before making a customer-impacting commitment.

### F. Field installation and inspection

- Mobile app works offline and syncs evidence when connected.
- Step-by-step install checklist adapts to the approved design and local inspection requirements.
- Voice-to-structured notes with a visible transcript and edit history.
- Photo capture guides framing and labels the component/location.
- Visual QA flags apparent missing labels, conduit, flashing, disconnects, grounding, equipment, or housekeeping evidence; it never declares code compliance solely from an image.
- Compare installed/as-built photos and measurements to the approved plan.
- Draft daily report, punch list, customer update, and inspection package.
- Book inspection and expose the inspector-ready checklist to the crew.

### G. Inspection → PTO → closeout

- Track inspection appointments, outcomes, corrections, reinspection, utility permission to operate, incentive/funding conditions, and final payment.
- Parse inspector and utility messages into actionable tasks.
- Generate closeout packet: approved plan, as-built changes, serial numbers, warranties, photos, manuals, monitoring setup, customer signoff, and service contact.
- Set up monitoring and confirm the customer can see the system.
- Trigger final invoice or funding request only when the configured evidence and approvals exist.
- Ask for a review only after a healthy system and successful handoff — never immediately after a frustrating delay.

### H. Service and fleet operations

- Ingest inverter, battery, gateway, and monitoring alerts.
- Deduplicate and classify events: likely communications issue, grid outage, production anomaly, weather, equipment fault, or customer education.
- Compare production against weather-normalized expectations, not a simplistic fixed threshold.
- Ask the customer for targeted information and remote evidence before dispatch.
- Recommend remote resolution, warranty route, or technician visit with parts and skill requirements.
- Correlate recurring failures by equipment model, crew, roof type, supplier batch, and install revision.
- Track warranty, SLA, service margin, and customer sentiment.

---

## 5. Automation maturity model

| Level | Meaning | Example |
|---|---|---|
| **0 — record** | human does the work; product stores evidence | rep uploads a permit receipt |
| **1 — recommend** | agent proposes next step with sources | “This job is missing the utility bill and a main-panel photo” |
| **2 — prepare** | agent drafts the work for one-click approval | prefilled permit form and plan-set checklist |
| **3 — execute under policy** | agent executes low-risk actions within limits and logs them | send an approved reminder, poll a portal, create a task, reserve inventory |
| **4 — exception-driven** | agent runs the happy path and asks only when policy/risk requires | submit a qualifying permit after all gates pass; escalate a correction letter |
| **5 — closed-loop** | measured outcomes improve playbooks and routing | update install-duration estimates after comparing planned vs actual work |

The launch target should be **Level 3 for administrative work and Level 1–2 for technical/safety work**. Level 4 is earned per workflow, jurisdiction, and customer communication class; it is not a global setting.

---

## 6. What can be automated today vs. what must stay human-led

### Strong candidates for automation today

- CRM/project synchronization and deduplication.
- Email/SMS/voice triage, summaries, reminders, appointment booking, and multilingual translation.
- Utility bill, permit, contract, invoice, correction-letter, and inspection-report extraction.
- Customer and project status updates with source-linked facts.
- Document assembly and versioning.
- Deterministic engineering calculations and catalog compatibility checks.
- Portal/API status polling and deadline tracking.
- Scheduling recommendations, route planning, weather alerts, and rebooking suggestions.
- Field note transcription, photo organization, checklist completion, and missing-evidence detection.
- Invoice/commission/job-cost drafts and reconciliation proposals.
- Monitoring alert classification and service triage.

### Good copilots, not autonomous authorities

- Roof measurement and array-layout drafts.
- Production/savings and battery-sizing scenarios.
- Code/compliance QA and permit-package review.
- Change-order pricing and customer explanations.
- Equipment substitution analysis.
- Visual field QA and as-built comparison.
- Warranty root-cause hypotheses.

### Hard stop without an authorized human

- Final structural/electrical engineering signoff.
- Safety-critical field instruction or work authorization.
- Permit or utility attestation where a responsible person must certify.
- Contract, financing, tax-credit, or guaranteed-savings representation.
- Energization, shutdown, or remote control of equipment where safety could be affected.
- Customer refunds, collections escalation, credit decisions, or legal responses.
- Any action where the agent cannot show the exact inputs, policy, and approver.

---

## 7. The system architecture

### Core services

1. **Project graph / system of record** — canonical IDs for customer, property, service point, project, design revision, equipment, document, permit, interconnection, visit, inspection, asset, warranty, and financial milestone.
2. **Event bus** — every meaningful change emits an event; workflows subscribe rather than relying on fragile point-to-point scripts.
3. **Durable workflow engine** — retries, timers, human approvals, deadlines, compensation, and resumability. A permit workflow must survive an outage and resume from the last verified state.
4. **Tool gateway** — typed connectors with scoped credentials, idempotency keys, rate limits, dry-run mode, and per-tool audit logs.
5. **Policy and approval engine** — evaluates role, jurisdiction, project risk, monetary threshold, confidence, and evidence completeness before allowing an action.
6. **Document intelligence** — OCR, classification, structured extraction, page/region citations, document comparison, redaction, and retention policy.
7. **Agent runtime** — LLMs for language/reasoning plus deterministic calculators, validators, retrieval, and computer-vision models. The model may propose a tool call; the gateway decides whether it is permitted.
8. **Operational UI** — queues, project timeline, approvals, exception inbox, analytics, and customer/crew portals.
9. **Evaluation and replay** — regression corpus of real anonymized bills, plans, permits, correction letters, photos, and conversations; every model/tool update replays against expected outputs.

### Architectural rule

**LLMs should choose and explain; deterministic services should calculate and enforce.**

For example, the model can say “the main-panel rating appears inconsistent with the plan” and point to the evidence. A typed electrical-rules service must calculate the actual check. A human or licensed workflow owner resolves an ambiguous case.

### Suggested initial stack

- Postgres for canonical records, permissions, and event projections.
- Object storage with immutable document versions and malware scanning.
- Durable workflow orchestration such as Temporal or an equivalent.
- Search/vector index for project-scoped retrieval, with citations back to source documents.
- Python/TypeScript connector services with a common tool schema.
- React web console plus an offline-first mobile field app.
- Managed voice/SMS, email, e-signature, payments, accounting, maps, weather, monitoring, and identity providers.
- OpenTelemetry-style tracing and an append-only audit log.

The exact vendors are less important than keeping the canonical data model and policy layer under product control.

---

## 8. Integration strategy

Design for adapters, not a forced rip-and-replace platform.

| Capability | Integration categories | Product stance |
|---|---|---|
| CRM and marketing | CRM, lead forms, ad sources, call tracking | import events; preserve the installer’s source of truth during rollout |
| Design and proposals | Aurora, OpenSolar, HelioScope, other CAD/simulation tools | store immutable design revisions and sold-scope snapshots |
| Solar resource and rates | PVWatts, irradiance, tariff/rate, interval-data providers | show assumptions and uncertainty; never mix rate versions silently |
| Permits and AHJs | SolarAPP+, municipal portals, permit APIs, email | prefer official API; browser automation is a fallback with human-visible runs |
| Interconnection/incentives | utility portals, PowerClerk and program APIs, email | model each program as a configurable state machine |
| Finance | lender/finance APIs, e-signature, payments, accounting/ERP | separate quote, contract, funding, invoice, and cash receipt states |
| Procurement | distributors, warehouse, purchase-order, serial-number systems | lock substitutions to an approved decision path |
| Field | mobile devices, GPS, camera, offline sync, route/weather | evidence-first; sync conflicts are explicit |
| Monitoring/service | inverter, battery, gateway, ticketing, warranty portals | normalize alerts and keep raw vendor payloads |
| Communication | SMS, email, voice, customer portal | consent, templates, recordings, disclosure, and opt-out are first-class |

### Reality check on available building blocks

The product does not need to invent all of the underlying solar capability. As of this brief’s date:

- NREL exposes the **PVWatts V8 API** for production estimates and weather/resource inputs: [developer.nrel.gov/docs/solar/pvwatts/v8](https://developer.nrel.gov/docs/solar/pvwatts/v8/).
- **SolarAPP+** is an automated permitting path for qualifying residential PV and storage projects in participating jurisdictions; NREL reported material time savings in its program evaluation, and the platform continues to publish API and workflow updates: [NREL program report](https://www.nrel.gov/news/program/2023/automated-permitting-speeds-solar-adoption-across-united-states.html) and [SolarAPP+ release notes](https://help.gosolarapp.org/article/180-software-releases).
- Clean Power Research exposes APIs for utility rates/bill savings, PowerClerk application/process automation, and solar simulation/data products: [developers.cleanpower.com](https://developers.cleanpower.com/).
- OpenSolar publishes an API intended to connect projects, designs, pricing, hardware, payments, workflows, and webhooks to external CRM/ops systems: [opensolar.com/api](https://www.opensolar.com/api/) and [developers.opensolar.com](https://developers.opensolar.com/api/).

These are enablers, not guarantees of universal coverage. Every integration needs capability discovery, jurisdiction tests, rate limits, terms-of-use review, and a manual fallback.

---

## 9. Trust, safety, and governance are product features

### Required controls

- Explicit AI disclosure for customer-facing interaction; easy human handoff and opt-out.
- Role-based and project-scoped access; agents receive short-lived, least-privilege credentials.
- Approval policies with monetary, legal, safety, jurisdiction, and confidence thresholds.
- Source citations for every extracted fact and model-generated recommendation.
- Immutable versioning of plans, BOMs, contracts, permit packets, and customer communications.
- Idempotent actions and duplicate-submission protection.
- Secrets vault, tenant isolation, encryption, retention/deletion controls, and audit export.
- Human-readable action preview before high-impact operations.
- Recordings and transcripts governed by state/local consent requirements.
- Model/data boundaries: do not train on customer documents or conversations without explicit rights and controls.
- Red-team tests for prompt injection in uploaded documents, fraudulent change requests, payment diversion, impersonation, and instruction conflicts.
- Incident response: pause an agent/workflow globally or by jurisdiction, roll back a playbook, and notify affected operators.

### Confidence is not enough

A low-confidence model output should not be the only reason to ask for review. A high-confidence model output can still be unsafe if the action is consequential. Use a matrix of:

`confidence × impact × reversibility × authorization × evidence completeness`

---

## 10. MVP: a credible first 90–120 days

### Scope

Choose one state/utility cluster and one customer segment: **standard residential PV + battery, existing homes, one or two design tools, one CRM, and a bounded set of AHJs**.

### MVP workflows

1. Ingest sold jobs from CRM/design platform.
2. Create a canonical project and immutable sold-scope snapshot.
3. Collect and extract survey/utility documents.
4. Generate the engineering and permit readiness checklist.
5. Assemble a draft permit/interconnection packet.
6. Run deterministic QA and route exceptions.
7. Submit or hand off through an approval gate.
8. Poll for status, parse correction letters, and maintain customer updates.
9. Create an install-readiness score and schedule recommendation.
10. Capture field evidence and produce an inspection/closeout packet.

### Explicitly out of MVP

- Fully autonomous sales negotiation.
- Multi-state code interpretation.
- Commercial/utility-scale engineering.
- Unattended portal automation across unknown sites.
- Automatic equipment substitutions.
- Remote control of inverters/batteries.
- General-purpose service dispatch across every manufacturer.

### MVP acceptance criteria

- Every project can answer: **what is blocking it, who owns the next action, what evidence supports that answer, and when will it be revisited?**
- Zero duplicate permit submissions in a controlled pilot.
- Every customer-facing claim links to a source or approved template.
- An operator can replay any agent action and see the exact inputs, tool result, policy evaluation, and approver.
- A human can pause, edit, or take over a workflow without losing state.
- The team measures time saved and error rates against the current process, not against a demo.

### Pilot design

Run in **shadow mode** for two weeks: the agent prepares work while staff execute normally. Compare its proposed packet, status, and next actions to the actual process. Then enable one low-risk action at a time: reminders, task creation, document requests, status polling, and only then approved submissions.

---

## 11. Metrics that matter

### Customer and revenue

- speed to first useful response;
- contact-to-appointment and appointment-to-signed conversion;
- proposal cycle time;
- cancellation rate and reasons;
- customer update SLA and satisfaction.

### Operations

- sold-to-survey, survey-to-design, design-to-permit, permit-to-install, install-to-PTO cycle times;
- first-pass permit and inspection rate;
- correction loops per project;
- projects stalled without an owner;
- schedule adherence and crew utilization;
- rework, truck rolls, and missing-evidence rate.

### Financial

- gross margin by project and by exception type;
- cost per installed watt / project;
- days sales outstanding and funding lag;
- commission accuracy;
- warranty/service cost per installed system.

### Agent quality

- autonomous action success rate;
- false-positive and false-negative exception rate;
- human override rate and reason;
- source-grounded answer rate;
- duplicate/unauthorized action rate;
- mean time to detect and recover from an agent error.

Do not optimize for “number of tasks automated.” Optimize for **faster, safer, more profitable completed projects with fewer surprises**.

---

## 12. Business model and moat

### Pricing options

- Base platform fee by active project volume.
- Usage for voice minutes, document pages, computer-vision analysis, and high-cost simulations.
- Premium modules for permitting/interconnection, field evidence, and service fleet.
- Optional managed operations for smaller installers during onboarding.

Avoid taking a percentage of financing or equipment revenue if trust is central; it can make recommendations look conflicted.

### Defensibility

- A normalized, versioned solar project graph across the full lifecycle.
- Jurisdiction and utility playbooks plus observed turnaround/correction patterns.
- Structured historical outcomes: which design, document, crew, supplier, and AHJ conditions predict rework.
- Evaluation datasets and deterministic rule libraries tied to approved outcomes.
- Deep workflow integration and operator trust, not a proprietary chat persona.

The moat is the **closed loop from planned → submitted → installed → inspected → producing → serviced**, with outcomes feeding future recommendations.

---

## 13. Strategic risks and mitigations

| Risk | Mitigation |
|---|---|
| AI makes a technical or safety error | narrow tools, deterministic validators, hard approval gates, evidence and audit trail |
| Portal/API access changes | adapter isolation, health checks, manual fallback, no silent data loss |
| Jurisdiction complexity overwhelms launch | one market first; versioned playbooks; local expert review |
| Customer is misled by an overly confident sales agent | approved claims library, ranges, source links, disclosure, human handoff |
| Installer does not trust automation | shadow mode, visible drafts, undo/pause, measure against baseline |
| Integration becomes a consulting business | canonical schemas, reusable connector contracts, repeatable onboarding pack |
| Model vendor costs or quality change | model gateway, task-specific routing, deterministic fallback, evaluation suite |
| Data/privacy/security incident | least privilege, tenant isolation, retention controls, red-team and audit program |
| Automation increases activity but not cash | tie workflows to installed/PTO/funded milestones and margin metrics |

---

## 14. The north-star demo

Give the agent a new signed job with an address, proposal, utility bill, and survey photos. It should:

1. explain the sold scope and identify discrepancies;
2. produce an engineering/permit readiness checklist with evidence;
3. draft the design and permit/interconnection packet using the approved tools;
4. surface exactly three blockers, each with an owner and suggested resolution;
5. get approval, submit through the correct path, and track the result;
6. schedule the install only when the readiness policy passes;
7. guide the crew through evidence capture;
8. produce the inspection/closeout packet;
9. notify the customer at each meaningful milestone; and
10. leave an auditable timeline that a human can trust.

If that experience works reliably in one bounded market, expand outward to sales, more AHJs/utilities, more equipment, commercial work, and service.

---

## 15. Product decisions to make next

1. **Initial operating geography:** which state, utilities, and AHJs can we support deeply?
2. **Customer profile:** installer-owned sales team, dealer network, EPC, or service-heavy operator?
3. **System of record:** which CRM/design/field/accounting stack must we integrate first?
4. **Business wedge:** permit-to-PTO, install readiness, service NOC, or lead-to-contract?
5. **Authority model:** what may the agent do automatically on day one, and who is accountable for each approval?
6. **Data access:** can we obtain 12–24 months of anonymized project documents and outcomes for evaluation?
7. **Human operations:** will the product only recommend, or will we offer a managed permit/ops desk during the pilot?
8. **Success threshold:** what measurable cycle-time, error-rate, margin, or staffing improvement makes the pilot a win?

### My recommendation

Pick one market and build the **project control plane first**. Make it excellent at turning a signed solar job into an approved, scheduled, evidence-complete, cash-generating installation. Once that loop is trustworthy, the same project graph becomes the foundation for autonomous sales follow-up, procurement, PTO, and service — without asking an AI to impersonate an entire company before it has earned the right.
