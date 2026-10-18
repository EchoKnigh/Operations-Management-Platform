-- Newtonite Ops schema. Plain SQL so constraints, indexes and triggers are explicit.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Roles are per team: a user can be Admin in one team and Viewer in another.
CREATE TABLE memberships (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('viewer','member','lead','admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX memberships_team_idx ON memberships (team_id);

CREATE TABLE work_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  description text NOT NULL DEFAULT '',
  type        text NOT NULL DEFAULT 'other'
              CHECK (type IN ('incident','customer_issue','payment','compliance','other')),
  priority    text NOT NULL DEFAULT 'medium'
              CHECK (priority IN ('low','medium','high','urgent')),
  status      text NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','in_progress','awaiting_approval','resolved','closed')),
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  creator_id  uuid NOT NULL REFERENCES users(id),
  -- Optimistic-lock counter: incremented on every state change.
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- An item being worked on or awaiting approval must have an owner.
  CONSTRAINT active_items_have_assignee
    CHECK (status IN ('open','resolved','closed') OR assignee_id IS NOT NULL)
);
CREATE INDEX work_items_team_status_idx ON work_items (team_id, status);
CREATE INDEX work_items_assignee_idx    ON work_items (assignee_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX work_items_urgent_unassigned_idx
  ON work_items (team_id, created_at) WHERE assignee_id IS NULL AND priority = 'urgent';

-- Append-only audit trail. Written in the same transaction as the change it describes.
CREATE TABLE activity (
  id           bigserial PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL
               CHECK (action IN ('created','status_changed','priority_changed','assignee_changed',
                                 'field_updated','comment_added')),
  field        text,
  old_value    text,
  new_value    text,
  comment      text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_item_idx ON activity (work_item_id, id);

CREATE FUNCTION activity_is_append_only() RETURNS trigger AS $$
BEGIN
  -- ON DELETE CASCADE / SET NULL from parent tables is still allowed.
  IF TG_OP = 'UPDATE' AND OLD.actor_id IS NOT NULL AND NEW.actor_id IS NULL
     AND OLD.work_item_id = NEW.work_item_id AND OLD.action = NEW.action
     AND OLD.comment IS NOT DISTINCT FROM NEW.comment THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'activity rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_no_update BEFORE UPDATE ON activity
  FOR EACH ROW EXECUTE FUNCTION activity_is_append_only();
CREATE TRIGGER activity_no_delete_direct BEFORE DELETE ON activity
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION activity_is_append_only();

-- Idempotency: one row per (user, key). The unique PK makes concurrent duplicates serialise.
CREATE TABLE idempotency_keys (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key           text NOT NULL,
  request_hash  text NOT NULL,
  status_code   integer,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_created_idx ON idempotency_keys (created_at);
