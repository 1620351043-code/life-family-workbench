-- B-009: owner-controlled member permissions for sensitive household abilities.
-- Non-owner members default to denied and the owner is always allowed by policy.

CREATE TABLE member_sensitive_permission (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES household(id),
  user_id uuid NOT NULL,
  capability text NOT NULL CHECK (capability IN (
    'ai_food_recommendation',
    'ai_topic_summary',
    'ai_finance_insight',
    'ai_cooking_assistant',
    'ai_memory_personalization',
    'media_original',
    'household_export'
  )),
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  granted_by uuid NOT NULL,
  granted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  UNIQUE (household_id, user_id, capability),
  FOREIGN KEY (household_id, user_id) REFERENCES household_member (household_id, user_id),
  FOREIGN KEY (household_id, granted_by) REFERENCES household_member (household_id, user_id),
  CHECK ((enabled AND granted_at IS NOT NULL AND revoked_at IS NULL)
      OR (NOT enabled AND revoked_at IS NOT NULL))
);

CREATE INDEX member_sensitive_permission_household_user_idx
  ON member_sensitive_permission (household_id, user_id, capability);

ALTER TABLE member_sensitive_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_sensitive_permission FORCE ROW LEVEL SECURITY;

CREATE POLICY member_sensitive_permission_scope ON member_sensitive_permission
  USING (household_id = nullif(current_setting('app.household_id', true), '')::uuid)
  WITH CHECK (household_id = nullif(current_setting('app.household_id', true), '')::uuid);

GRANT SELECT ON member_sensitive_permission TO life_app;

CREATE OR REPLACE FUNCTION life_family_list_sensitive_permissions(
  input_household_id uuid,
  input_actor_id uuid,
  input_member_user_id uuid
)
RETURNS TABLE (
  capability text,
  enabled boolean,
  explicit boolean,
  version integer,
  granted_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE actor_role text;
DECLARE target_role text;
BEGIN
  IF nullif(current_setting('app.household_id', true), '')::uuid IS DISTINCT FROM input_household_id
     OR nullif(current_setting('app.user_id', true), '')::uuid IS DISTINCT FROM input_actor_id THEN
    RAISE EXCEPTION 'household member access denied' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO actor_role FROM household_member
   WHERE household_id = input_household_id AND user_id = input_actor_id AND status = 'active';
  SELECT role INTO target_role FROM household_member
   WHERE household_id = input_household_id AND user_id = input_member_user_id AND status = 'active';
  IF actor_role IS NULL OR target_role IS NULL OR (actor_role <> 'owner' AND input_actor_id <> input_member_user_id) THEN
    RAISE EXCEPTION 'sensitive permission access denied' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH capabilities(capability) AS (
    VALUES ('ai_food_recommendation'::text), ('ai_topic_summary'), ('ai_finance_insight'),
           ('ai_cooking_assistant'), ('ai_memory_personalization'), ('media_original'), ('household_export')
  )
  SELECT c.capability,
         CASE WHEN target_role = 'owner' THEN true ELSE COALESCE(p.enabled, false) END,
         p.id IS NOT NULL,
         COALESCE(p.version, 0),
         p.granted_at,
         p.revoked_at,
         p.updated_at
    FROM capabilities c
    LEFT JOIN member_sensitive_permission p
      ON p.household_id = input_household_id
     AND p.user_id = input_member_user_id
     AND p.capability = c.capability
   ORDER BY CASE c.capability
     WHEN 'ai_food_recommendation' THEN 1 WHEN 'ai_topic_summary' THEN 2
     WHEN 'ai_finance_insight' THEN 3 WHEN 'ai_cooking_assistant' THEN 4
     WHEN 'ai_memory_personalization' THEN 5 WHEN 'media_original' THEN 6 ELSE 7 END;
END
$$;

CREATE OR REPLACE FUNCTION life_family_update_sensitive_permission(
  input_id uuid,
  input_household_id uuid,
  input_actor_id uuid,
  input_member_user_id uuid,
  input_capability text,
  input_enabled boolean,
  input_expected_version integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE current_row member_sensitive_permission%ROWTYPE;
DECLARE target_role text;
BEGIN
  IF input_expected_version < 0 OR input_capability NOT IN (
    'ai_food_recommendation', 'ai_topic_summary', 'ai_finance_insight',
    'ai_cooking_assistant', 'ai_memory_personalization', 'media_original', 'household_export'
  ) THEN RETURN 0; END IF;
  IF nullif(current_setting('app.household_id', true), '')::uuid IS DISTINCT FROM input_household_id
     OR nullif(current_setting('app.user_id', true), '')::uuid IS DISTINCT FROM input_actor_id
     OR NOT EXISTS (
       SELECT 1 FROM household_member
        WHERE household_id = input_household_id AND user_id = input_actor_id
          AND status = 'active' AND role = 'owner'
     ) THEN
    RAISE EXCEPTION 'household owner required' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO target_role FROM household_member
   WHERE household_id = input_household_id AND user_id = input_member_user_id AND status = 'active';
  IF target_role IS NULL OR target_role = 'owner' THEN RETURN 0; END IF;

  SELECT * INTO current_row FROM member_sensitive_permission
   WHERE household_id = input_household_id AND user_id = input_member_user_id
     AND capability = input_capability
   FOR UPDATE;

  IF NOT FOUND THEN
    IF input_expected_version <> 0 THEN RETURN -1; END IF;
    INSERT INTO member_sensitive_permission (
      id, household_id, user_id, capability, enabled, version, granted_by, granted_at, revoked_at
    ) VALUES (
      input_id, input_household_id, input_member_user_id, input_capability, input_enabled, 1,
      input_actor_id, CASE WHEN input_enabled THEN now() ELSE NULL END,
      CASE WHEN input_enabled THEN NULL ELSE now() END
    );
    RETURN 1;
  END IF;

  IF current_row.version <> input_expected_version THEN RETURN -1; END IF;
  IF current_row.enabled = input_enabled THEN RETURN -2; END IF;

  UPDATE member_sensitive_permission
     SET enabled = input_enabled,
         version = version + 1,
         granted_by = input_actor_id,
         granted_at = CASE WHEN input_enabled THEN now() ELSE granted_at END,
         revoked_at = CASE WHEN input_enabled THEN NULL ELSE now() END,
         updated_at = now()
   WHERE household_id = input_household_id AND user_id = input_member_user_id
     AND capability = input_capability;
  RETURN current_row.version + 1;
END
$$;

CREATE OR REPLACE FUNCTION life_family_assert_sensitive_permission(
  input_household_id uuid,
  input_actor_id uuid,
  input_capability text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE actor_role text;
BEGIN
  IF nullif(current_setting('app.household_id', true), '')::uuid IS DISTINCT FROM input_household_id
     OR nullif(current_setting('app.user_id', true), '')::uuid IS DISTINCT FROM input_actor_id THEN
    RETURN false;
  END IF;
  SELECT role INTO actor_role FROM household_member
   WHERE household_id = input_household_id AND user_id = input_actor_id AND status = 'active';
  IF actor_role = 'owner' THEN RETURN true; END IF;
  RETURN EXISTS (
    SELECT 1 FROM member_sensitive_permission
     WHERE household_id = input_household_id AND user_id = input_actor_id
       AND capability = input_capability AND enabled
  );
END
$$;

-- Role changes invalidate both finance and household-sensitive grants.
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

  UPDATE household_member SET role = input_role, updated_at = now()
   WHERE household_id = input_household_id AND user_id = input_member_user_id
     AND status = 'active' AND role <> 'owner' AND role <> input_role;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed = 1 THEN
    UPDATE financial_permission
       SET can_view = false, can_bookkeep = false, can_edit = false,
           can_import = false, can_reconcile = false, can_export = false,
           granted_by = input_actor_id, revoked_at = now(), updated_at = now()
     WHERE household_id = input_household_id AND user_id = input_member_user_id;
    UPDATE member_sensitive_permission
       SET enabled = false, version = version + 1, granted_by = input_actor_id,
           revoked_at = now(), updated_at = now()
     WHERE household_id = input_household_id AND user_id = input_member_user_id AND enabled;
  END IF;
  RETURN changed = 1;
END
$$;

REVOKE ALL ON FUNCTION life_family_list_sensitive_permissions(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION life_family_update_sensitive_permission(uuid, uuid, uuid, uuid, text, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION life_family_assert_sensitive_permission(uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION life_family_list_sensitive_permissions(uuid, uuid, uuid) TO life_app;
GRANT EXECUTE ON FUNCTION life_family_update_sensitive_permission(uuid, uuid, uuid, uuid, text, boolean, integer) TO life_app;
GRANT EXECUTE ON FUNCTION life_family_assert_sensitive_permission(uuid, uuid, text) TO life_app;
