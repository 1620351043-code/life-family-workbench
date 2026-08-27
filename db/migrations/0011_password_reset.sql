-- Password reset credentials are single-use bearer secrets. The raw token is
-- delivered to the user and never stored. PostgreSQL keeps only SHA-256.
-- This table, like user_session, is intentionally outside tenant RLS because
-- reset happens before a household session exists. Access remains limited to
-- the application role and narrow SECURITY DEFINER functions.

CREATE TABLE password_reset_token (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-fA-F]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  user_agent text,
  ip_address inet
);

CREATE UNIQUE INDEX password_reset_token_active_user_idx
  ON password_reset_token (user_id)
  WHERE used_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_token TO life_app;

CREATE OR REPLACE FUNCTION life_auth_create_password_reset(
  input_id uuid,
  input_email text,
  input_token_hash text,
  input_expires_at timestamptz,
  input_user_agent text,
  input_ip_address inet
)
RETURNS TABLE (email text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH target AS (
    SELECT u.id, u.email
      FROM app_user u
      JOIN household_member hm ON hm.user_id = u.id AND hm.status = 'active'
     WHERE lower(u.email) = lower(input_email)
     LIMIT 1
  ), inserted AS (
    INSERT INTO password_reset_token (id, user_id, token_hash, expires_at, user_agent, ip_address)
    SELECT input_id, target.id, input_token_hash, input_expires_at, left(input_user_agent, 500), input_ip_address
      FROM target
    ON CONFLICT (user_id) WHERE used_at IS NULL DO UPDATE
      SET token_hash = EXCLUDED.token_hash,
          expires_at = EXCLUDED.expires_at,
          created_at = now(),
          user_agent = EXCLUDED.user_agent,
          ip_address = EXCLUDED.ip_address
    RETURNING user_id
  )
  SELECT target.email
    FROM target JOIN inserted ON inserted.user_id = target.id
$$;

REVOKE ALL ON FUNCTION life_auth_create_password_reset(uuid, text, text, timestamptz, text, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION life_auth_create_password_reset(uuid, text, text, timestamptz, text, inet) TO life_app;

CREATE OR REPLACE FUNCTION life_auth_apply_password_reset(input_token_hash text, input_password_hash text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH consumed AS (
    UPDATE password_reset_token
       SET used_at = now()
     WHERE token_hash = input_token_hash
       AND used_at IS NULL
       AND expires_at > now()
    RETURNING user_id
  ), password_changed AS (
    UPDATE app_user user_record
       SET password_hash = input_password_hash
      FROM consumed
     WHERE user_record.id = consumed.user_id
    RETURNING user_record.id
  ), reset_tokens_revoked AS (
    UPDATE password_reset_token token
       SET used_at = now()
      FROM password_changed
     WHERE token.user_id = password_changed.id
       AND token.used_at IS NULL
    RETURNING token.id
  ), sessions_revoked AS (
    UPDATE user_session session_record
       SET revoked_at = now()
      FROM password_changed
     WHERE session_record.user_id = password_changed.id
       AND session_record.revoked_at IS NULL
    RETURNING session_record.id
  )
  SELECT EXISTS (SELECT 1 FROM password_changed)
$$;

REVOKE ALL ON FUNCTION life_auth_apply_password_reset(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION life_auth_apply_password_reset(text, text) TO life_app;
