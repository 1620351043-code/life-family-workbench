-- B-010: tenant-scoped data-rights disclosure and reversible deletion scheduling.
-- Physical deletion is deliberately delegated to a later audited worker.

CREATE TABLE data_deletion_request (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES household(id),
  requested_by uuid NOT NULL,
  request_type text NOT NULL CHECK (request_type IN ('account', 'household')),
  target_user_id uuid,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'processing', 'cancelled', 'completed', 'failed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  execute_after timestamptz NOT NULL,
  scope_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, requested_by) REFERENCES household_member (household_id, user_id),
  FOREIGN KEY (household_id, target_user_id) REFERENCES household_member (household_id, user_id),
  CHECK ((request_type = 'account' AND target_user_id = requested_by)
      OR (request_type = 'household' AND target_user_id IS NULL)),
  CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL)
      OR (status <> 'cancelled' AND cancelled_at IS NULL)),
  CHECK ((status = 'completed' AND completed_at IS NOT NULL)
      OR (status <> 'completed' AND completed_at IS NULL))
);

CREATE UNIQUE INDEX data_deletion_request_active_account_uq
  ON data_deletion_request (household_id, target_user_id, request_type)
  WHERE status IN ('scheduled', 'processing') AND request_type = 'account';

CREATE UNIQUE INDEX data_deletion_request_active_household_uq
  ON data_deletion_request (household_id, request_type)
  WHERE status IN ('scheduled', 'processing') AND request_type = 'household';

CREATE INDEX data_deletion_request_due_idx
  ON data_deletion_request (status, execute_after)
  WHERE status = 'scheduled';

ALTER TABLE data_deletion_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_deletion_request FORCE ROW LEVEL SECURITY;

CREATE POLICY data_deletion_request_scope ON data_deletion_request
  USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid);

GRANT SELECT ON data_deletion_request TO life_app;

CREATE OR REPLACE FUNCTION life_data_schedule_deletion(
  input_id uuid,
  input_household_id uuid,
  input_actor_id uuid,
  input_request_type text,
  input_wait_days integer,
  input_scope_summary jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE actor_role text;
BEGIN
  IF nullif(current_setting('app.household_id', true), '')::uuid IS DISTINCT FROM input_household_id
     OR nullif(current_setting('app.user_id', true), '')::uuid IS DISTINCT FROM input_actor_id THEN
    RAISE EXCEPTION 'household member access denied' USING ERRCODE = '42501';
  END IF;
  IF input_request_type NOT IN ('account', 'household') OR input_wait_days < 1 OR input_wait_days > 30 THEN
    RETURN NULL;
  END IF;

  SELECT role INTO actor_role
    FROM household_member
   WHERE household_id = input_household_id AND user_id = input_actor_id AND status = 'active';
  IF actor_role IS NULL THEN
    RAISE EXCEPTION 'active household member required' USING ERRCODE = '42501';
  END IF;
  IF input_request_type = 'household' AND actor_role <> 'owner' THEN
    RAISE EXCEPTION 'household owner required' USING ERRCODE = '42501';
  END IF;
  IF input_request_type = 'account' AND actor_role = 'owner' THEN
    RETURN NULL;
  END IF;

  INSERT INTO data_deletion_request (
    id, household_id, requested_by, request_type, target_user_id,
    execute_after, scope_summary
  ) VALUES (
    input_id, input_household_id, input_actor_id, input_request_type,
    CASE WHEN input_request_type = 'account' THEN input_actor_id ELSE NULL END,
    now() + (input_wait_days * interval '1 day'), COALESCE(input_scope_summary, '{}'::jsonb)
  );
  RETURN input_id;
END
$$;

CREATE OR REPLACE FUNCTION life_data_cancel_deletion(
  input_household_id uuid,
  input_actor_id uuid,
  input_request_id uuid,
  input_expected_version integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE current_row data_deletion_request%ROWTYPE;
DECLARE actor_role text;
BEGIN
  IF input_expected_version < 1
     OR nullif(current_setting('app.household_id', true), '')::uuid IS DISTINCT FROM input_household_id
     OR nullif(current_setting('app.user_id', true), '')::uuid IS DISTINCT FROM input_actor_id THEN
    RAISE EXCEPTION 'household member access denied' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO actor_role
    FROM household_member
   WHERE household_id = input_household_id AND user_id = input_actor_id AND status = 'active';
  IF actor_role IS NULL THEN
    RAISE EXCEPTION 'active household member required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO current_row
    FROM data_deletion_request
   WHERE household_id = input_household_id AND id = input_request_id
   FOR UPDATE;
  IF NOT FOUND OR current_row.status <> 'scheduled' THEN RETURN 0; END IF;
  IF current_row.version <> input_expected_version THEN RETURN -1; END IF;
  IF current_row.request_type = 'account' AND current_row.requested_by <> input_actor_id THEN
    RAISE EXCEPTION 'account deletion owner required' USING ERRCODE = '42501';
  END IF;
  IF current_row.request_type = 'household' AND actor_role <> 'owner' THEN
    RAISE EXCEPTION 'household owner required' USING ERRCODE = '42501';
  END IF;

  UPDATE data_deletion_request
     SET status = 'cancelled', version = version + 1, cancelled_at = now(), updated_at = now()
   WHERE household_id = input_household_id AND id = input_request_id;
  RETURN current_row.version + 1;
END
$$;

REVOKE ALL ON FUNCTION life_data_schedule_deletion(uuid, uuid, uuid, text, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION life_data_cancel_deletion(uuid, uuid, uuid, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION life_data_schedule_deletion(uuid, uuid, uuid, text, integer, jsonb) TO life_app;
GRANT EXECUTE ON FUNCTION life_data_cancel_deletion(uuid, uuid, uuid, integer) TO life_app;
