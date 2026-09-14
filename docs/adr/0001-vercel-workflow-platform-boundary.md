# ADR 0001: Vercel Workflow is a replaceable execution mechanism

## Status

Accepted

## Context

DealRadar may need durable execution for Gemini evaluation work that should not
remain inside a synchronous import request. The Vercel Workflow tracer recorded
that a sequential batch can run inside one durable step without Workflow Event
consumption increasing per evaluated product.

That result supports Vercel Workflow as the current orchestration mechanism. It
does not make Vercel Workflow part of DealRadar's business model or persistent
state.

## Decision

DealRadar may use Vercel Workflow for durable execution. Vercel-specific code
must be confined to an orchestration adapter that invokes DealRadar application
operations.

```text
Vercel Workflow
      ↓
orchestration adapter
      ↓
DealRadar application operations
      ↓
Postgres / Gemini / recommendation semantics
```

The following remain DealRadar application semantics and must not depend on
Vercel Workflow APIs or types:

- candidate selection and #34 deterministic preselection;
- #36's maximum total evaluation workload created by one import;
- `workflowBatchSize`, which controls only the number of already-selected
  candidates processed in one durable step;
- #35 Gemini evaluation plus bounded retry and failure behavior;
- evaluation batching logic;
- persistence and any future evaluation-run state;
- recommendation selection;
- Slack formatting and notification semantics.

Business operations executed by a Workflow must also be callable independently
of Vercel. Postgres remains the system of record for DealRadar application
state; Gemini is an evaluation service, and Slack remains a notification output.

## Consequences

- Replacing Vercel Workflow should be local to the orchestration adapter rather
  than requiring changes to selection, evaluation, persistence,
  recommendation, or notification behavior.
- Future durable-processing work may call application operations from a Vercel
  Workflow, but must not move application semantics into Vercel-specific APIs.
- This decision does not introduce Vercel Workflow runtime code, evaluation-run
  persistence, a generic queue or job abstraction, or any production cutover.
- `/api/import-deals` and the behavior established by #34, #35, and #36 remain
  unchanged by this decision.
