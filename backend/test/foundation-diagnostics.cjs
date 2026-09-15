// Only fixed repository-owned labels may enter public CI output.
const stages = Object.freeze({
  "start": "OUTBOX_START",
  "Redis readiness": "OUTBOX_REDIS_READINESS",
  "Redis monitor": "OUTBOX_REDIS_MONITOR",
  "database fixture": "OUTBOX_DATABASE_FIXTURE",
  "starting hosts": "OUTBOX_STARTING_HOSTS",
  "worker connection readiness": "OUTBOX_WORKER_CONNECTION_READINESS",
  "design fanout": "OUTBOX_DESIGN_FANOUT",
  "subscriber interruption": "OUTBOX_SUBSCRIBER_INTERRUPTION",
  "retry": "OUTBOX_RETRY",
  "lost target ack": "OUTBOX_LOST_TARGET_ACK",
  "Redis outage and empty restart": "OUTBOX_REDIS_OUTAGE_AND_EMPTY_RESTART",
  "crash after commit": "OUTBOX_CRASH_AFTER_COMMIT",
  "crash after dispatch before ack": "OUTBOX_CRASH_AFTER_DISPATCH_BEFORE_ACK",
  "crash recovery draining renders": "OUTBOX_CRASH_RECOVERY_DRAINING_RENDERS",
  "throughput": "OUTBOX_THROUGHPUT",
  "WP-18 durable playback through empty Redis restart": "OUTBOX_WP_18_DURABLE_PLAYBACK_THROUGH_EMPTY_REDIS_RESTART"
});
const codes = new Set(Object.values(stages));
module.exports = { stages, codes };
