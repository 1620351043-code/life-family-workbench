-- B-007/B-008: one-time household invitations and owner-controlled member roles.
-- Raw invitation codes never enter PostgreSQL. Only SHA-256 digests are stored.

CREATE TABLE household_invitation (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES household(id),
  created_by uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-fA-F]{64}$'),
  role text NOT NULL CHECK (role IN ('adult', 'child', 'guest')),
  expires_at timestamptz NOT NULL,
  accepted_by uuid REFERENCES app_user(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by) REFERENCES household_member (household_id, user_id),
  CHECK ((accepted_at IS NULL) = (accepted_by IS NULL)),
  CHECK (expires_at > created_at)
);

CREATE INDEX household_invitation_household_status_idx
  ON household_invitation (household_id, created_at DESC);

CREATE INDEX household_invitation_active_token_idx
  ON household_invitation (token_hash, expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE household_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_invitation FORCE ROW LEVEL SECURITY;

-- life_app is the only role with direct table access. SECURITY DEFINER
-- functions run as the migration owner and need the non-life_app branch for
-- pre-authentication invitation preview/acceptance.
CREATE POLICY household_invitation_scope ON household_invitation
  USING (
    current_user <> 'life_app'
    OR household_id = nullif(current_setting('app.household_id', true), '')::uuid
  )
  WITH CHECK (
    current_user <> 'life_app'
    OR household_id = nullif(current_setting('app.household_id', true), '')::uuid
  );

GRANT SELECT ON household_invitation TO life_app;

-- Keep the historical table grant compatible with existing finance reads, but
-- prevent life_app from bypassing the controlled invitation/role functions.
CREATE OR REPLACE FUNCTION life_guard_household_member_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user = 'life_app' THEN
    RAISE EXCEPTION 'direct household membership mutation denied' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER household_member_controlled_mutation
BEFORE INSERT OR UPDATE OR DELETE ON household_member
FOR EACH ROW EXECUTE FUNCTION life_guard_household_member_mutation();

CREATE OR REPLACE FUNCTION life_family_list_members(input_household_id uuid, input_actor_id uuid)
RETURNS TABLE (
  user_id uuid,
  email text,
  role text,
  status text,
  joined_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF nullif(current_setting('app.household_id', true), '')::uuid IS DISTINCT FROM input_household_id
     OR nullif(current_setting('app.user_id', true), '')::uuid IS DISTINCT FROM input_actor_id
     OR NOT EXISTS (
       SELECT 1 FROM household_member actor
        WHERE actor.household_id = input_household_id AND actor.user_id = input_actor_id AND actor.status = 'active'
     ) THEN
    RAISE EXCEPTION 'household member access denied' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT hm.user_id, u.email, hm.role, hm.status, hm.created_at
    FROM household_member hm
    JOIN app_user u ON u.id = hm.user_id
   WHERE hm.household_id = input_household_id AND hm.status = 'active'
   ORDER BY CASE hm.role WHEN 'owner' THEN 0 WHEN 'adult' THEN 1 WHEN 'child' THEN 2 ELSE 3 END,
            hm.created_at ASC;
END
$$;

CREATE OR REPLACE FUNCTION life_family_create_invitation(
  input_id uuid,
  input_household_id uuid,
  input_created_by uuid,
  input_token_hash text,
  input_role text,
  input_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF input_role NOT IN ('adult', 'child', 'guest')
     OR input_expires_at <= now()
     OR input_expires_at > now() + interval '31 days' THEN
    RETURN false;
  END IF;
  IF nullif(current_setting('app.household_id', true), '')::uuid IS DISTINCT FROM input_household_id
     OR nullif(current_setting('app.user_id', true), '')::uuid IS DISTINCT FROM input_created_by
     OR NOT EXISTS (
       SELECT 1 FROM household_member
        WHERE household_id = input_household_id AND user_id = input_created_by
          AND status = 'active' AND role = 'owner'
     ) THEN
    RAISE EXCEPTION 'household owner required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO household_invitation (id, household_id, created_by, token_hash, role, expires_at)
  VALUES (input_id, input_household_id, input_created_by, input_token_hash, input_role, input_expires_at);
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION life_family_revoke_invitation(
  input_household_id uuid,
  input_actor_id uuid,
  input_invitation_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE changed integer;
BEGIN
  IF nullif(current_setting('app.household_id', true), '')::uuid IS DISTINCT FROM input_household_id
     OR nullif(current_setting('app.user_id', true), '')::uuid IS DISTINCT FROM input_actor_id
     OR NOT EXISTS (
       SELECT 1 FROM household_member
        WHERE household_id = input_household_id AND user_id = input_actor_id
          AND status = 'active' AND role = 'owner'
     ) THEN
    RAISE EXCEPTION 'household owner required' USING ERRCODE = '42501';
  END IF;

  UPDATE household_invitation
     SET revoked_at = now(), updated_at = now()
   WHERE household_id = input_household_id AND id = input_invitation_id
     AND accepted_at IS NULL AND revoked_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;

CREATE OR REPLACE FUNCTION life_family_update_member_role(
  input_household_id uuid,
  input_actor_id uuid,
  input_member_user_id uuid,
  input_role text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE changed integer;
BEGIN
  IF input_role NOT IN ('adult', 'child', 'guest') THEN RETURN false; END IF;
  IF nullif(current_setting('app.household_id', true), '')::uuid IS DISTINCT FROM input_household_id
     OR nullif(current_setting('app.user_id', true), '')::uuid IS DISTINCT FROM input_actor_id
     OR NOT EXISTS (
       SELECT 1 FROM household_member
        WHERE household_id = input_household_id AND user_id = input_actor_id
          AND status = 'active' AND role = 'owner'
     ) THEN
    RAISE EXCEPTION 'household owner required' USING ERRCODE = '42501';
  END IF;

  UPDATE household_member
     SET role = input_role, updated_at = now()
   WHERE household_id = input_household_id AND user_id = input_member_user_id
     AND status = 'active' AND role <> 'owner' AND role <> input_role;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed = 1 THEN
    UPDATE financial_permission
       SET can_view = false, can_bookkeep = false, can_edit = false,
           can_import = false, can_reconcile = false, can_export = false,
           granted_by = input_actor_id, revoked_at = now(), updated_at = now()
     WHERE household_id = input_household_id AND user_id = input_member_user_id;
  END IF;
  RETURN changed = 1;
END
$$;

CREATE OR REPLACE FUNCTION life_auth_preview_household_invitation(input_token_hash text)
RETURNS TABLE (
  invitation_status text,
  invitation_id uuid,
  household_id uuid,
  household_name text,
  inviter_email text,
  role text,
  expires_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
           WHEN i.accepted_at IS NOT NULL THEN 'used'
           WHEN i.revoked_at IS NOT NULL THEN 'revoked'
           WHEN i.expires_at <= now() THEN 'expired'
           ELSE 'active'
         END,
         i.id, i.household_id, h.name, u.email, i.role, i.expires_at
    FROM household_invitation i
    JOIN household h ON h.id = i.household_id
    JOIN app_user u ON u.id = i.created_by
   WHERE i.token_hash = input_token_hash
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION life_auth_accept_household_invitation(
  input_user_id uuid,
  input_member_id uuid,
  input_email text,
  input_password_hash text,
  input_token_hash text
)
RETURNS TABLE (
  invitation_status text,
  user_id uuid,
  email text,
  household_id uuid,
  household_name text,
  role text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE invitation_row household_invitation%ROWTYPE;
BEGIN
  SELECT * INTO invitation_row
    FROM household_invitation
   WHERE token_hash = input_token_hash
   FOR UPDATE;

  IF NOT FOUND THEN invitation_status := 'invalid'; RETURN NEXT; RETURN; END IF;
  IF invitation_row.accepted_at IS NOT NULL THEN invitation_status := 'used'; RETURN NEXT; RETURN; END IF;
  IF invitation_row.revoked_at IS NOT NULL THEN invitation_status := 'revoked'; RETURN NEXT; RETURN; END IF;
  IF invitation_row.expires_at <= now() THEN invitation_status := 'expired'; RETURN NEXT; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM app_user existing WHERE lower(existing.email) = lower(input_email)) THEN
    invitation_status := 'email_registered'; RETURN NEXT; RETURN;
  END IF;

  INSERT INTO app_user (id, email, password_hash)
  VALUES (input_user_id, lower(input_email), input_password_hash);
  INSERT INTO household_member (id, household_id, user_id, role)
  VALUES (input_member_id, invitation_row.household_id, input_user_id, invitation_row.role);
  UPDATE household_invitation
     SET accepted_by = input_user_id, accepted_at = now(), updated_at = now()
   WHERE id = invitation_row.id;

  invitation_status := 'accepted';
  user_id := input_user_id;
  email := lower(input_email);
  household_id := invitation_row.household_id;
  SELECT name INTO household_name FROM household WHERE id = invitation_row.household_id;
  role := invitation_row.role;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION life_family_list_members(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION life_guard_household_member_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION life_family_create_invitation(uuid, uuid, uuid, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION life_family_revoke_invitation(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION life_family_update_member_role(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION life_auth_preview_household_invitation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION life_auth_accept_household_invitation(uuid, uuid, text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION life_family_list_members(uuid, uuid) TO life_app;
GRANT EXECUTE ON FUNCTION life_family_create_invitation(uuid, uuid, uuid, text, text, timestamptz) TO life_app;
GRANT EXECUTE ON FUNCTION life_family_revoke_invitation(uuid, uuid, uuid) TO life_app;
GRANT EXECUTE ON FUNCTION life_family_update_member_role(uuid, uuid, uuid, text) TO life_app;
GRANT EXECUTE ON FUNCTION life_auth_preview_household_invitation(text) TO life_app;
GRANT EXECUTE ON FUNCTION life_auth_accept_household_invitation(uuid, uuid, text, text, text) TO life_app;
