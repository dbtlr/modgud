---
description: Index of Modgud's architecture decision records, with the status semantics that govern how each decision binds current work.
---

# Decisions

Architecture decision records (ADRs). Each decision's frontmatter `status` says how it binds the work in front of you:

- **accepted**: load-bearing. Change course only through a new ADR that supersedes it.
- **proposed**: a candidate, not yet a constraint. Discuss work that would violate one before proceeding.
- **superseded**: follow the decision named in `superseded_by` instead; this one remains for history.
- **deprecated**: no longer applies.

## Index

- [ADR-0001 — Callers reach a Service through a Grant, and Modgud is its own OAuth 2.1 authorization server](0001-callers-reach-services-through-grants-modgud-is-its-own-oauth-server.md) (proposed)
- [ADR-0002 — Each MCP session gets its own child process, and the Grant's Identity enters through its environment](0002-one-child-per-session-identity-enters-through-the-environment.md) (proposed)
- [ADR-0003 — Two listeners split the public surface from everything a person clicks](0003-two-listeners-anything-a-person-clicks-lives-on-the-tailnet.md) (accepted)
- [ADR-0004 — The Admin listener may bind loopback behind a tailnet forward](0004-the-admin-listener-may-bind-loopback-behind-a-tailnet-forward.md) (accepted)
