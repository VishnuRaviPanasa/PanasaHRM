# observability/

Dashboards, alert rules and SLO definitions, version-controlled. Built in Phase 2 - **before**
feature work, because instrumentation retrofitted afterwards is always incomplete.

- **Logs:** pino JSON -> OTel collector -> Loki. Every line carries `request_id`, `trace_id`,
  `user_id`, `module`, `event`, `duration_ms`. A classification-aware redaction layer strips
  SENSITIVE/RESTRICTED fields; a lint rule bans logging raw entities.
- **Metrics:** Prometheus. RED for HTTP, queue depth and failures per BullMQ queue, DB pool, plus
  **business metrics** - approvals pending by age, attendance ingested vs expected, permission denials.
- **Traces:** OTel -> Tempo. **Trace context propagates through the outbox**, so a notification is
  traceable back to the request that caused it. That is the difference between an observable
  system and a pile of logs.

Alerts are few and actionable, each linking to a runbook. Anything that fires without requiring
an action gets deleted.
