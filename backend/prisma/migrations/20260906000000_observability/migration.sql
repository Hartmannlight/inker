-- Preserve every existing row. Legacy events acquire a stable context only at
-- consumption time; reads never backfill this nullable metadata column.
ALTER TABLE outbox_events ADD COLUMN correlation_id TEXT
CHECK (correlation_id IS NULL OR (
  length(correlation_id) = 36
  AND substr(correlation_id, 9, 1) = '-'
  AND substr(correlation_id, 14, 1) = '-'
  AND substr(correlation_id, 19, 1) = '-'
  AND substr(correlation_id, 24, 1) = '-'
  AND length(replace(correlation_id, '-', '')) = 32
  AND replace(correlation_id, '-', '') NOT GLOB '*[^0-9a-f]*'
));

CREATE TRIGGER outbox_correlation_immutable
BEFORE UPDATE OF correlation_id ON outbox_events
WHEN NEW.correlation_id IS NOT OLD.correlation_id
BEGIN
  SELECT RAISE(ABORT, 'OUTBOX_CORRELATION_IMMUTABLE');
END;
