CREATE TABLE events (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  banner_url TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'upcoming', 'live', 'ended', 'archived')),
  is_visible INTEGER NOT NULL DEFAULT 0 CHECK (is_visible IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (starts_at < ends_at)
);

CREATE INDEX events_status_visibility_idx ON events(status, is_visible, starts_at);

CREATE TABLE event_mods (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  artwork_url TEXT,
  external_url TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'hidden' CHECK (visibility IN ('hidden', 'revealed')),
  revealed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (event_id, identifier)
);

CREATE INDEX event_mods_event_position_idx ON event_mods(event_id, position);
CREATE INDEX event_mods_event_visibility_idx ON event_mods(event_id, visibility, position);

CREATE TABLE admin_users (
  id TEXT PRIMARY KEY NOT NULL,
  identity_subject TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'organizer')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX admin_users_role_active_idx ON admin_users(role, is_active);

CREATE TABLE event_permissions (
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role = 'organizer'),
  granted_by TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, event_id)
);

CREATE INDEX event_permissions_event_role_idx ON event_permissions(event_id, role);

CREATE TABLE event_state_versions (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  last_mutation_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  actor_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC);
CREATE INDEX audit_logs_event_created_idx ON audit_logs(event_id, created_at DESC);
