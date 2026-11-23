-- Keep the user-facing audit timeline read-only for client sessions.
-- Application audit events are written by trusted server-side service_role code.
DROP POLICY IF EXISTS activity_logs_insert_own ON public.activity_logs;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.activity_logs FROM authenticated;
