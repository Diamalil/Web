CREATE TABLE public.feeku_server_sessions (
  sid text PRIMARY KEY,
  sess jsonb NOT NULL,
  expire timestamptz NOT NULL
);

CREATE INDEX feu_server_sessions_expire_idx
  ON public.feeku_server_sessions (expire);

ALTER TABLE public.feeku_server_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.feeku_server_sessions
  FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feeku_server_sessions
  TO service_role;

CREATE POLICY "service role manages FeeKu server sessions"
  ON public.feeku_server_sessions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.feeku_server_sessions IS
  'Server-side express-session storage. Accessible only to service_role.';
