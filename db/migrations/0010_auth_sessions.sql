-- Production authentication sessions. The raw token never enters PostgreSQL;
-- only its SHA-256 digest is stored. The session table is intentionally not
-- tenant-RLS protected because the resolver must find a tenant before it can
-- set app.user_id/app.household_id. It is only exposed to the application
-- role through the narrow grants below.

CREATE TABLE user_session (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id),
  household_id uuid NOT NULL REFERENCES household(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-fA-F]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  user_agent text,
  ip_address inet,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, user_id) REFERENCES household_member (household_id, user_id)
);

CREATE INDEX user_session_active_lookup_idx
  ON user_session (token_hash, expires_at)
  WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON user_session TO life_app;

-- Login must look up the password hash before a tenant context exists. Keep
-- that lookup inside a narrowly scoped SECURITY DEFINER function owned by the
-- migration role, the API receives only the row it needs for verification.
CREATE OR REPLACE FUNCTION life_auth_lookup_user(input_email text)
RETURNS TABLE (
  user_id uuid,
  email text,
  password_hash text,
  household_id uuid,
  household_name text,
  role text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, u.email, u.password_hash, h.id, h.name, hm.role
    FROM app_user u
    JOIN household_member hm ON hm.user_id = u.id AND hm.status = 'active'
    JOIN household h ON h.id = hm.household_id
   WHERE lower(u.email) = lower(input_email)
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION life_auth_lookup_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION life_auth_lookup_user(text) TO life_app;

CREATE OR REPLACE FUNCTION life_auth_register_user(input_user_id uuid, input_household_id uuid, input_member_id uuid, input_email text, input_password_hash text, input_household_name text)
RETURNS TABLE (
  user_id uuid,
  email text,
  household_id uuid,
  household_name text,
  role text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH new_user AS (
    INSERT INTO app_user (id, email, password_hash)
    VALUES (input_user_id, lower(input_email), input_password_hash)
    RETURNING id, email
  ), new_household AS (
    INSERT INTO household (id, name)
    VALUES (input_household_id, input_household_name)
    RETURNING id, name
  ), new_member AS (
    INSERT INTO household_member (id, household_id, user_id, role)
    VALUES (input_member_id, input_household_id, input_user_id, 'owner')
    RETURNING user_id, household_id, role
  )
  SELECT nu.id, nu.email, nh.id, nh.name, nm.role
    FROM new_user nu CROSS JOIN new_household nh CROSS JOIN new_member nm
$$;

REVOKE ALL ON FUNCTION life_auth_register_user(uuid, uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION life_auth_register_user(uuid, uuid, uuid, text, text, text) TO life_app;
