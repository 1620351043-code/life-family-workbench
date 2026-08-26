-- Family space and tenant-scoped AI foundation.
-- Run after 0003_life_app_privileges.sql with the migration role.

CREATE TABLE family_topic (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  author_id uuid NOT NULL,
  topic_type text NOT NULL CHECK (topic_type IN ('idea', 'request', 'inspiration', 'memory', 'other')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, author_id) REFERENCES household_member (household_id, user_id)
);

CREATE TABLE family_topic_comment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  topic_id uuid NOT NULL,
  author_id uuid NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, topic_id) REFERENCES family_topic (household_id, id),
  FOREIGN KEY (household_id, author_id) REFERENCES household_member (household_id, user_id)
);

CREATE TABLE ai_memory_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  owner_user_id uuid,
  memory_key text NOT NULL CHECK (char_length(memory_key) BETWEEN 1 AND 120),
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, owner_user_id) REFERENCES household_member (household_id, user_id)
);

CREATE UNIQUE INDEX ai_memory_household_key_idx
  ON ai_memory_document (household_id, memory_key)
  WHERE owner_user_id IS NULL;
CREATE UNIQUE INDEX ai_memory_user_key_idx
  ON ai_memory_document (household_id, owner_user_id, memory_key)
  WHERE owner_user_id IS NOT NULL;

CREATE TABLE ai_insight (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  topic_id uuid NOT NULL,
  insight_type text NOT NULL CHECK (insight_type IN ('summary', 'recommendation', 'memory_update')),
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider text NOT NULL,
  model text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, topic_id) REFERENCES family_topic (household_id, id),
  FOREIGN KEY (household_id, created_by) REFERENCES household_member (household_id, user_id)
);

CREATE TABLE ai_action_proposal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  insight_id uuid NOT NULL,
  action_type text NOT NULL CHECK (action_type IN ('publish_summary_comment', 'update_memory')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'rejected', 'expired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, insight_id) REFERENCES ai_insight (household_id, id),
  FOREIGN KEY (household_id, created_by) REFERENCES household_member (household_id, user_id),
  FOREIGN KEY (household_id, decided_by) REFERENCES household_member (household_id, user_id)
);

CREATE TABLE ai_action_execution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id),
  proposal_id uuid NOT NULL,
  executed_by uuid NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, proposal_id) REFERENCES ai_action_proposal (household_id, id),
  FOREIGN KEY (household_id, executed_by) REFERENCES household_member (household_id, user_id)
);

CREATE INDEX family_topic_household_created_idx ON family_topic (household_id, created_at DESC);
CREATE INDEX family_topic_comment_topic_created_idx ON family_topic_comment (household_id, topic_id, created_at ASC);
CREATE INDEX ai_insight_topic_created_idx ON ai_insight (household_id, topic_id, created_at DESC);
CREATE INDEX ai_action_proposal_status_idx ON ai_action_proposal (household_id, status, created_at DESC);

ALTER TABLE family_topic ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_topic FORCE ROW LEVEL SECURITY;
ALTER TABLE family_topic_comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_topic_comment FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_memory_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_memory_document FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_insight ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_insight FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_action_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_action_proposal FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_action_execution ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_action_execution FORCE ROW LEVEL SECURITY;

-- Member email is used for display only and must remain household-scoped.
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;
CREATE POLICY app_user_scope ON app_user
USING (
  id = current_setting('app.user_id', true)::uuid
  OR EXISTS (
    SELECT 1 FROM household_member hm
     WHERE hm.household_id = current_setting('app.household_id', true)::uuid
       AND hm.user_id = app_user.id
  )
);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'family_topic', 'family_topic_comment', 'ai_memory_document',
    'ai_insight', 'ai_action_proposal', 'ai_action_execution'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (household_id = current_setting(''app.household_id'', true)::uuid) WITH CHECK (household_id = current_setting(''app.household_id'', true)::uuid)',
      table_name || '_scope', table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON family_topic, family_topic_comment,
  ai_memory_document, ai_insight, ai_action_proposal, ai_action_execution TO life_app;
GRANT SELECT ON app_user TO life_app;
