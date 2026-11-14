ALTER TABLE events ADD COLUMN scheduled_starts_at TEXT;
ALTER TABLE events ADD COLUMN scheduled_ends_at TEXT;

UPDATE events
SET scheduled_starts_at = starts_at,
    scheduled_ends_at = ends_at;
