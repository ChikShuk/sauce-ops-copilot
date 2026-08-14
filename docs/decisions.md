# Design Decisions

## 2026-08-13 — Postgres as queue instead of Redis
**Context:** Need a queue for async event processing. The brief warns against adding Redis just to satisfy the assignment.
**Decision:** Postgres with `SELECT ... FOR UPDATE SKIP LOCKED` for job claiming, plus a transactional outbox table.
**Alternatives:** Redis + BullMQ (extra service, and permanent state would risk living outside the durable store); SQS (not runnable offline in Docker).
**Consequence:** One fewer container, outbox and jobs share transactions with business data. Ceiling is lower than a real broker — fine at this scale, noted in the README as a production change.