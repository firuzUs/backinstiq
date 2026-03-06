-- Запустите в Supabase → SQL Editor

CREATE TABLE IF NOT EXISTS render_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'queued',
  progress      INTEGER DEFAULT 0,
  scenes        JSONB NOT NULL DEFAULT '[]',
  assets        JSONB NOT NULL DEFAULT '[]',
  settings      JSONB NOT NULL DEFAULT '{}',
  result_url    TEXT,
  error_message TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_render_jobs_user_id ON render_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs(status);

ALTER TABLE render_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own jobs"
  ON render_jobs FOR SELECT
  USING (auth.uid() = user_id);

ALTER PUBLICATION supabase_realtime ADD TABLE render_jobs;
