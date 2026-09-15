# ContextOS Product Design Specification

Status: approved design baseline
Updated: 2026-09-14
Target: desktop product design before backend implementation

## 1. Product Definition

ContextOS is a local-first Agent Workspace and work-context governance system for developers who use Claude Code, Codex, Cursor, and other coding agents.

It helps a user preserve project continuity across agents, inspect what happened during work, govern reusable context, record durable decisions, organize executable work, and explicitly control automated behavior.

ContextOS is not primarily:

- A chatbot
- A memory engine
- A personal knowledge graph
- A personality-analysis product
- A generic AI dashboard
- A project-management suite
- A marketing website

## 2. Domain Model

The primary product objects are:

- `Project`: the workspace boundary and governance container
- `Session`: one concrete agent work episode
- `Review Item`: one governance issue requiring human attention
- `Decision`: one durable, versioned choice and its rationale
- `Work Item`: one bounded, executable unit of work
- `Rule`: one versioned, declarative governance instruction

Context is a supporting domain:

- `Context Source`: a governed source of work context
- `Evidence Snapshot`: an immutable capture of source evidence
- `Context Item`: normalized or derived content from a source

Supporting derived artifacts include summaries, resume capsules, structured notes, extraction results, and other generated documents.

## 3. Integrity Model

- Original conversations are read-only evidence.
- Evidence Snapshots are immutable and read-only.
- Derived artifacts are editable only through explicit versioning.
- Context Items must be labeled as derived content.
- Derived content must never be presented as authoritative source evidence.
- Every active derived object exposes provenance.
- AI may propose; the user controls activation where governance matters.
- Historical versions remain inspectable after archive, disable, supersede, reverse, cancel, or completion.
- Destructive actions require confirmation.
- Overrides require permission and a written reason.

## 4. Page Ownership

Every product page owns one object or one tightly bounded domain.

The owning object supplies the page's main register, detail workspace, filters, actions, lifecycle, validation, empty states, and backend contract.

Cross-module relationships may appear only as:

- Compact object references
- IDs and short titles
- Small counts
- Links to the owning page
- Provenance or relationship hints

Never embed another module's full table, editor, transcript, timeline, settings panel, or dashboard.

Examples:

- Projects may show `6 Sessions`, but not a Session timeline.
- Sessions may show `2 Decisions created`, but not a Decision editor.
- Work Items may link to execution Sessions, but not embed runtime traces.
- Rules may create Review Items, but do not embed Review Inbox.
- Context may show usage counts, but not Session, Decision, or Work Item records.

Overview is the only intentionally aggregated page. It must remain compact and operational.

## 5. Visual Direction

The default appearance is `Pure Light Workspace`.

The product should feel precise, quiet, technical, cold, and suitable for repeated daily use. It should resemble a refined developer operations tool rather than a consumer AI product.

Required qualities:

- Dense but readable
- Strong information hierarchy
- Crisp typography
- Thin borders
- Stable table and panel geometry
- Restrained semantic color
- Clear focus and selection states
- Minimal decoration

Do not use:

- A black sidebar beside white content
- Split black-and-white composition
- Warm beige, cream, sand, tan, or brown palettes
- Lime or yellow-green as the primary accent
- Purple or neon AI gradients
- Decorative glows, orbs, or bokeh
- Marketing heroes
- Oversized dashboard cards
- Cards nested inside cards
- Decorative AI illustrations
- Stock photography
- Realistic or generated human portraits
- Personality-profile widgets
- Automatic Skill pages as a primary module
- Knowledge graphs as the main Context interface

Pure Dark Mode may be designed later as a complete alternative theme. Never mix light and dark themes inside one application shell.

## 6. Color System

### Light theme

- App background: `#F8FAFC`
- Primary surface: `#FFFFFF`
- Secondary surface: `#F1F5F9`
- Hover surface: `#E8EDF5`
- Primary text: `#0F172A`
- Secondary text: `#475569`
- Muted text: `#64748B`
- Quiet text: `#94A3B8`
- Default border: `#E2E8F0`
- Strong border: `#CBD5E1`
- Primary blue: `#2563EB`
- Primary blue hover: `#1D4ED8`
- Selected background: `#EDF4FE`
- Selected border: `#BFDBFE`

### Semantic colors

- Success text: `#15803D`
- Success background: `#ECFDF5`
- Warning text: `#B45309`
- Warning background: `#FFFBEB`
- Error text: `#B91C1C`
- Error background: `#FEF2F2`
- Information text: `#1D4ED8`
- Information background: `#EFF6FF`

Semantic colors communicate meaning only. Color is never the sole status indicator.

## 7. Typography

- Interface font: IBM Plex Sans
- Technical metadata font: IBM Plex Mono
- Page title: 22-24px, weight 600
- Section title: 15-16px, weight 600
- Body: 13-14px, weight 400
- Compact row text: 12-13px
- Metadata: 10-12px, monospace
- Button text: 12-13px, weight 500 or 600

Do not use hero-scale typography. Use neutral letter spacing except for compact uppercase navigation group labels.

## 8. Shape and Spacing

- Base spacing unit: 4px
- Common spacing: 4, 8, 12, 16, 20, 24, and 32px
- Default radius: 4px
- Maximum radius: 8px
- Border width: 1px
- Minimum desktop target: 32px
- Page content padding: 24px

Use full-height work surfaces, tables, rows, dividers, and restrained panels. Do not style every section as a floating card.

## 9. Desktop Shell

The current design phase is desktop-only.

- Reference frame: 1440 x 1024
- Fixed white sidebar: 244px
- Fixed white utility header: 64px
- Main background: `#F8FAFC`
- Sidebar and header border: `#E2E8F0`
- Main content begins below the utility header and to the right of the sidebar
- Two-column object pages use a register on the left and selected-object workspace on the right
- Detail headers remain visible while detail content scrolls
- Tables use stable column widths and sticky headers where useful

Do not generate tablet or mobile frames until explicitly requested.

## 10. Navigation

```text
WORKSPACE
Overview
Projects
Sessions

GOVERNANCE
Review Inbox
Decisions
Work Items
Context

SYSTEM
Rules
```

Navigation rules:

- White sidebar
- Cool-gray text and borders
- Active row background: `#EDF4FE`
- Active text and icon: `#2563EB` or `#1D4ED8`
- Optional 3px blue left indicator
- Restrained line icons
- No dark navigation rail

The sidebar footer may show daemon state, local endpoint, and Settings.

User identity uses initials or a generic person icon. Never use a photographic avatar.

## 11. Shared Page Pattern

Most object pages use:

1. Page header with title, concise supporting line, search, and one primary create action
2. Compact filter toolbar
3. Dense object register
4. Selected-object detail workspace
5. Contextual lifecycle actions
6. Immutable activity or version history where required

Avoid KPI card rows unless the metric is essential to the page's owned object.

### Shared states

Every page accounts for:

- Loading
- Empty
- No filter results
- Read-only permission
- Save in progress
- Save failure with retry
- Concurrent update conflict
- Missing referenced object
- Unsaved changes warning

Empty states use concise text and one relevant action. Do not use illustrations.

## 12. Overview

Purpose: provide the minimum cross-object information required to resume work.

Primary surfaces:

- Current Project
- Last Session and resume state
- Next Work Items
- Pending Review Item count
- Recent Activity
- Compact Context health

The Overview may aggregate objects because resuming work is its responsibility. It must not become a broad analytics dashboard or duplicate full module interfaces.

Primary action: `Continue in Agent`.

Backend aggregate:

```text
GET /api/workspace/overview?projectId=:projectId
```

## 13. Projects

Owned object: `Project`.

A Project defines the workspace boundary within which agents, context, rules, and work are governed.

Project-owned sections:

- Project Identity
- Workspace Boundary
- Context Source configuration
- Default Rule references
- Agent Access
- Project Health
- Lifecycle and Audit History

Primary actions:

- Create Project
- Edit configuration
- Activate
- Pause
- Archive
- Restore

Sessions, Decisions, Work Items, Rules, and Review Items appear only as compact counts or links.

Core API:

```text
GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
POST   /api/projects/:id/activate
POST   /api/projects/:id/pause
POST   /api/projects/:id/archive
POST   /api/projects/:id/restore
GET    /api/projects/:id/health
GET    /api/projects/:id/linked-counts
```

## 14. Sessions

Owned object: `Session`.

A Session is one concrete agent work episode inside a Project.

Session-owned sections:

- Session Identity
- Session Intent
- Runtime State
- Context Loaded
- Evidence Trace
- Artifacts Produced
- Resume Capsule
- Review Notes
- Lifecycle and Activity

Primary actions:

- Create or import Session
- Continue
- Review
- Archive

Project is shown as a link. Decisions and Work Items created by a Session appear only as counts or references.

Core API:

```text
GET    /api/sessions
POST   /api/sessions
GET    /api/sessions/:id
PATCH  /api/sessions/:id
POST   /api/sessions/:id/continue
POST   /api/sessions/:id/review
POST   /api/sessions/:id/archive
GET    /api/sessions/:id/context-pack
GET    /api/sessions/:id/evidence
GET    /api/sessions/:id/artifacts
GET    /api/sessions/:id/resume-capsule
PATCH  /api/sessions/:id/resume-capsule
POST   /api/sessions/import-transcript
```

## 15. Review Inbox

Owned object: `Review Item`.

A Review Item is a governance issue requiring human attention.

Primary layout: high-density review queue plus selected Review Item workspace.

Review Item-owned sections:

- Review Summary
- Trigger
- Evidence Delta
- Proposed Resolution
- Reviewer Decision
- Assignment and Due State
- Action Log

Primary actions:

- Assign
- Start review
- Resolve
- Dismiss
- Bulk triage
- Claim next item

The page may inspect issues originating elsewhere, but it must never become the editor for the source object.

Core API:

```text
GET    /api/review-items
POST   /api/review-items
GET    /api/review-items/:id
PATCH  /api/review-items/:id
POST   /api/review-items/:id/assign
POST   /api/review-items/:id/start
POST   /api/review-items/:id/resolve
POST   /api/review-items/:id/dismiss
GET    /api/review-items/:id/evidence-delta
GET    /api/review-items/:id/action-log
POST   /api/review-items/claim-next
POST   /api/review-items/bulk-assign
POST   /api/review-items/bulk-status
```

## 16. Decisions

Owned object: `Decision`.

A Decision is a durable, versioned record of an important choice.

Decision-owned sections:

- Decision Statement
- Context and Problem
- Rationale
- Alternatives Considered
- Consequences
- Validation and Review
- References
- Version History

Lifecycle:

- Draft
- Proposed
- Accepted
- Superseded
- Reversed
- Archived

Accepted Decisions are not silently rewritten. Material outcome changes require superseding or reversing the existing Decision.

Core API:

```text
GET    /api/decisions
POST   /api/decisions
GET    /api/decisions/:id
PATCH  /api/decisions/:id
POST   /api/decisions/:id/propose
POST   /api/decisions/:id/accept
POST   /api/decisions/:id/supersede
POST   /api/decisions/:id/reverse
POST   /api/decisions/:id/archive
POST   /api/decisions/:id/review
GET    /api/decisions/:id/versions
GET    /api/decisions/:id/compare
```

## 17. Work Items

Owned object: `Work Item`.

A Work Item is a bounded, actionable unit of work that can be assigned to a human or agent and evaluated against explicit completion criteria.

Work Item-owned sections:

- Work Definition
- Execution Contract
- Acceptance Criteria
- Readiness
- Work Item Dependencies
- Child Work Items
- Assignment and Schedule
- Execution Attempt Summaries
- Result
- Activity

Lifecycle:

- Backlog
- Ready
- In Progress
- Blocked
- In Review
- Done
- Canceled

Sessions appear only as execution-attempt links. A Work Item defines what must be completed; a Session records one attempt to execute it.

Core API:

```text
GET    /api/work-items
POST   /api/work-items
GET    /api/work-items/:id
PATCH  /api/work-items/:id
POST   /api/work-items/:id/mark-ready
POST   /api/work-items/:id/start
POST   /api/work-items/:id/block
POST   /api/work-items/:id/resolve-blocker
POST   /api/work-items/:id/send-to-review
POST   /api/work-items/:id/complete
POST   /api/work-items/:id/reopen
POST   /api/work-items/:id/cancel
GET    /api/work-items/:id/readiness
GET    /api/work-items/:id/dependencies
GET    /api/work-items/:id/attempts
```

## 18. Context

Primary managed object: `Context Source`.

Subordinate objects:

- `Evidence Snapshot`
- `Context Item`

Primary layout: Context Source register plus selected-source workspace.

Context-owned sections:

- Source Identity
- Location and Connection
- Inclusion Scope
- Refresh and Freshness
- Evidence Snapshots
- Derived Context Items
- Availability
- Provenance
- Compact Usage References

Evidence Snapshot rules:

- Immutable
- Read-only
- Inspectable and comparable
- Cannot be silently rewritten
- Cannot be deleted while referenced by completed work

Context Item rules:

- Explicitly labeled as derived content
- Editable only through versions
- Never presented as authoritative evidence

The Context page uses the same cold-white shell, table density, blue selection states, and typography as every other page. Do not use a document-gallery, memory-feed, graph, or special knowledge-product aesthetic.

Core API:

```text
GET    /api/context-sources
POST   /api/context-sources
GET    /api/context-sources/:id
PATCH  /api/context-sources/:id
POST   /api/context-sources/:id/test-connection
POST   /api/context-sources/:id/sync
POST   /api/context-sources/:id/enable
POST   /api/context-sources/:id/disable
POST   /api/context-sources/:id/archive
GET    /api/context-sources/:id/sync-history
GET    /api/context-sources/:id/snapshots
GET    /api/context-sources/:id/context-items
GET    /api/context-sources/:id/usage-counts
GET    /api/evidence-snapshots/:id
GET    /api/evidence-snapshots/:id/compare/:otherSnapshotId
POST   /api/evidence-snapshots/:id/verify
GET    /api/context-items/:id
PATCH  /api/context-items/:id
GET    /api/context-items/:id/versions
POST   /api/context-items/:id/versions
POST   /api/context-items/:id/archive
```

## 19. Rules

Owned object: `Rule`.

A Rule is a versioned, declarative governance instruction that evaluates defined conditions and produces a controlled effect.

Primary layout: Rule register plus selected Rule editor and validation workspace.

Rule-owned sections:

- Rule Identity
- Scope
- Structured Conditions
- Effect
- Enforcement and Precedence
- Exceptions
- Validation
- Conflict Analysis
- Deterministic Rule Test
- Usage
- Version History
- Audit Log

Enforcement modes:

- Advisory
- Warning
- Require Review
- Block

Use a structured condition builder with a read-only expression preview. Do not use conversational rule authoring or a full-screen code editor.

Invalid Rules and Rules with unresolved precedence conflicts cannot be activated. Editing an active Rule creates a new Draft version; the current active version remains effective until its replacement is validated and activated.

The Rules page uses the same cold-white shell and register-plus-detail structure as other pages. Do not switch to a dark developer-console aesthetic.

Core API:

```text
GET    /api/rules
POST   /api/rules
GET    /api/rules/:id
PATCH  /api/rules/:id
POST   /api/rules/:id/validate
POST   /api/rules/:id/activate
POST   /api/rules/:id/disable
POST   /api/rules/:id/archive
POST   /api/rules/:id/restore
POST   /api/rules/:id/new-version
GET    /api/rules/:id/conflicts
GET    /api/rules/:id/usage
GET    /api/rules/:id/evaluations
POST   /api/rules/:id/test
GET    /api/rules/:id/versions
GET    /api/rules/:id/compare
GET    /api/rules/:id/audit-log
POST   /api/rules/validate-all
```

## 20. Shared Components

### Buttons

- Primary: blue background and white text
- Secondary: white background, gray border, dark text
- Destructive: neutral until confirmation; red for the final destructive action
- Icon-only controls require tooltips

### Status labels

- Use compact labels or dots with text
- Avoid oversized pills
- Keep repeated table labels dimensionally stable
- Always write the status meaning

### Tables and registers

- Dense rows
- Stable column widths
- Sticky headers where useful
- Hover, focus, selected, disabled, stale, blocked, and error states
- Bulk-action bar appears only after selection

### Forms

- Menus for option sets
- Toggles for binary settings
- Structured rows for Rule conditions
- Checklists for readiness and acceptance criteria
- Inline validation near the affected field
- Confirmation for destructive lifecycle changes

### Icons

Use restrained line icons from one consistent icon family. Icons communicate actions or object types; do not decorate every heading.

## 21. Accessibility

- Minimum body size: 13px
- Minimum desktop target: 32px
- Visible keyboard focus rings
- Strong text contrast
- No color-only status communication
- Long IDs and paths truncate safely with the full value available on hover
- Loading, error, disabled, selected, and read-only states remain distinguishable
- Tooltips name unfamiliar icon actions

## 22. Backend Alignment

- The frontend consumes resource-oriented APIs matching page ownership.
- Overview may use one aggregate endpoint.
- Object pages fetch their owned resource and small linked counts separately.
- Cross-module references use IDs and links rather than embedded domain payloads.
- Evidence endpoints do not expose mutation operations.
- Versioned resources expose explicit version creation and comparison endpoints.
- Lifecycle changes use explicit action endpoints rather than ambiguous field mutations.
- Concurrent writes use version or revision checks.
- Audit events include actor, timestamp, action, and concise change metadata.

## 23. Current Deliverables

Required desktop screens:

1. Overview
2. Projects
3. Sessions
4. Review Inbox
5. Decisions
6. Work Items
7. Context
8. Rules
9. Pure Dark Overview compatibility reference
10. Shared components and state examples

Tablet and mobile designs are outside the current phase.

## 24. Stitch and Figma Guardrails

When generating or revising a screen:

- Preserve the shared white sidebar and white utility header.
- Use the light-theme tokens in this document.
- Keep the page centered on its owning object.
- Keep cross-module relationships as compact references.
- Generate one desktop screen at a time.
- Do not invent navigation modules.
- Do not add portraits, stock photos, or decorative AI imagery.
- Do not add warm colors.
- Do not create split light/dark layouts.
- Do not generate mobile or tablet variants.
- Do not replace operational tables with decorative cards.
- Do not silently alter immutable evidence.
- Keep component dimensions stable across loading and interactive states.
- Use the same shell, typography, spacing, and interaction language across all pages.

## 25. Acceptance Checklist

A design is acceptable only when:

- The owning object is immediately clear.
- Other modules appear only as references, counts, or links.
- The shell is pure light and visually cold.
- No warm palette or dark-light split is present.
- No portrait or decorative AI image is present.
- The main workflow is usable without explanatory marketing copy.
- Evidence and derived content are visually and behaviorally distinct.
- Lifecycle actions are contextual and auditable.
- Loading, empty, error, permission, and conflict states are defined.
- The layout is desktop-only and consistent with the shared shell.
