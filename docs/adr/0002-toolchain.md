# ADR 0002: Maintained infrastructure libraries and independent feature code

Status: accepted in PR #1; implementation follows the milestone plan.
Date: 2026-10-10

## Context and options

Small similar projects provide useful feasibility evidence but would import
active-tab assumptions, UI dependencies, unclear maturity or different licensing.
The owner requires WXT, Valibot and maintained modern tools. Alternatives are a
feature-project fork, a framework-free extension, and WXT with our own feature
implementation.

## Decision

Use WXT + TypeScript + Valibot and implement domain behavior independently.
Do not copy feature code from the small researched projects. Prefer native APIs
and established dependencies for infrastructure; do not write cryptographic
primitives ourselves. Argon2/CBOR choices need separate evidence when required.

Use Bun workspace dependencies, mise tasks/tool pins, shared hk presets,
Oxlint/Oxfmt, and separate type checking. Use supported Node for tools such as cf.
Keep one complete hk verification graph locally and in CI. No duplicate package
scripts or competing lint/format stacks by default.

Keep concise English repository instructions, one documentation index, a single
implementation plan, and ADRs for lasting decisions. Current references, proposed
work and historical evidence remain distinguishable.

## Consequences and verification

Feature code is ours to maintain; dependencies still require maintenance/license
review and interoperable tests. WXT does not solve Chrome policy restrictions.
Application schemas use Valibot without promising the entire transitive tooling
graph excludes Zod. M1 must establish actual compatible locks and checks; current
version research is not proof of a working installation.
