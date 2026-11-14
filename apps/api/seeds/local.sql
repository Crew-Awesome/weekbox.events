INSERT OR IGNORE INTO events (
  id,
  slug,
  name,
  description,
  starts_at,
  ends_at,
  scheduled_starts_at,
  scheduled_ends_at,
  status,
  is_visible
) VALUES (
  'dev-event-001',
  'funk-fest-local-preview',
  'Funk Fest (Local Preview)',
  'Sample event for the local preview.',
  '2027-03-12T18:00:00Z',
  '2027-03-12T23:00:00Z',
  '2027-03-12T18:00:00Z',
  '2027-03-12T23:00:00Z',
  'draft',
  1
)
ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,name=excluded.name,description=excluded.description,
  starts_at=excluded.starts_at,ends_at=excluded.ends_at,scheduled_starts_at=excluded.scheduled_starts_at,
  scheduled_ends_at=excluded.scheduled_ends_at,status=excluded.status,is_visible=excluded.is_visible,
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');

UPDATE events SET status='upcoming', is_visible=1 WHERE id='dev-event-001';

INSERT OR IGNORE INTO event_state_versions (event_id, version)
VALUES ('dev-event-001', 1);

INSERT OR IGNORE INTO event_mods (id, event_id, identifier, title, description, artwork_url, external_url, position, visibility)
VALUES
  ('dev-mod-001', 'dev-event-001', 'starlight-demo', 'Starlight Demo Mod', 'Local preview mod.', NULL, NULL, 0, 'hidden'),
  ('dev-mod-002', 'dev-event-001', 'moonbase-demo', 'Moonbase Demo Mod', 'Second local preview mod.', NULL, NULL, 1, 'revealed');

INSERT OR IGNORE INTO admin_users (id, identity_subject, email, display_name, role)
VALUES
  ('local-owner', 'owner@local.weekbox.test', 'owner@local.weekbox.test', 'Local owner', 'owner'),
  ('local-organizer', 'organizer@local.weekbox.test', 'organizer@local.weekbox.test', 'Local organizer', 'organizer');

INSERT OR IGNORE INTO event_permissions (user_id, event_id, role, granted_by)
VALUES
  ('local-organizer', 'dev-event-001', 'organizer', 'local-owner');
