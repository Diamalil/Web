-- Restore is a privileged replacement operation. Only the trusted Express server
-- may invoke it with the user ID established from the validated Supabase session.
DROP FUNCTION IF EXISTS public.restore_feeku_user_backup(jsonb);

CREATE FUNCTION public.restore_feeku_user_backup(p_user_id uuid, p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF coalesce((SELECT auth.jwt() ->> 'role'), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role is required' USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A valid account is required' USING ERRCODE = '22023';
  END IF;

  RETURN private.replace_feeku_business_data(p_user_id, p_data, true);
END;
$function$;

REVOKE ALL ON FUNCTION public.restore_feeku_user_backup(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_feeku_user_backup(uuid, jsonb)
  TO service_role;
