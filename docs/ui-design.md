# AI Agent MemoryHub UI design inventory

## Artifact and audience

- Artifact: responsive local-first control-plane dashboard.
- Primary audience: one technical user who wants to inspect, approve, project, and delete memories shared across AI clients.
- Primary viewport: 1440 x 960 desktop; mobile acceptance viewport: 390 x 844.
- Concept reference: the owner-provided desktop settings screenshot used during
  visual comparison. The private source path is intentionally not committed.

## Layout

- Desktop: fixed 236 px navigation rail and a fluid workspace.
- Overview: connector status rail, then a three-column operational grid (timeline, proposals, context preview).
- Settings: two-column policy editor and before/after preview.
- Mobile: compact top bar, horizontal section tabs, single-column cards, no clipped controls.
- Information density is deliberate: the product is an operations console, not a marketing page.

## Visual tokens

- Canvas: `#f4f7fb`; cards: `#ffffff`.
- Navigation: `#0b1f3a`; navigation secondary: `#7890ac`.
- Primary: `#1769e0`; primary hover: `#0f57c3`.
- Success: `#16856b`; success surface: `#e7f7f1`.
- Warning: `#b66b13`; warning surface: `#fff5df`.
- Danger: `#bf3b4b`; danger surface: `#fff0f2`.
- Text: `#172033`; muted: `#66758a`; border: `#dce4ee`.
- Radius: 12 px controls, 18 px cards; shadow is quiet and only separates cards from canvas.
- Typography: system sans stack; 13 px operational copy, 15 px body, 24–30 px page title.

## Core components and states

- Navigation: overview, memories, context packs, connectors, environment doctor, Claude account safety, audit, settings.
- Sync evidence: the overview separates connector capability, local runtime,
  adapter acceptance, and destination readback; it never offers a global switch
  that could imply unsupported automatic delivery.
- Connector rail: `connected`, `manual`, `limited`, `not configured`; state labels never imply native vendor memory was written.
- Proposal queue: approve and reject/forget actions; empty, loading, and error states.
- Context preview: target selector, scope label, canonical/projection distinction, copy action.
- International expression polish: default off, independently scoped to Claude Web and Claude Code, preview-before-use option, protected-fact checklist.
- Delivery labels: queued, accepted, context injected, delivered unverified, readback verified, blocked, failed. Only readback verified may render as “已同步”.
- Environment doctor: local checks, JSON/report export, dry-run setup plan, and an explicit apply boundary.
- Claude account safety: no anti-ban guarantee; local pause/resume, official eligibility/status/support links, credential and connector checklist, and a visible no-bypass boundary.
- Optional network probe: exact command is visible, contacts only the two documented Claude hosts for DNS/TLS, and explicitly excludes public-IP, reputation, and geolocation checks.

## Interaction and accessibility

- Every icon-only affordance has an accessible name; switches expose `role=switch` and `aria-checked`.
- Keyboard focus uses a visible blue outline; controls retain at least 44 px touch height on mobile.
- Reduced-motion users get no animated transforms.
- Destructive actions use explicit text and confirmation; secrets are never rendered in diagnostics.
- All network-dependent states retain a readable local fallback marked “演示数据”.

## Image decision

No decorative imagery is used in the implementation. The reference screenshot
guided composition, while the shipped artifact is a dense operations dashboard
where icons and state color carry the useful meaning.
