-- Create a profile for every new Supabase Auth user.
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text;
begin
  v_display_name := left(
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Pengguna'
    ),
    100
  );

  insert into public.profiles (id, display_name)
  values (new.id, v_display_name)
  on conflict (id) do update
    set display_name = excluded.display_name,
        updated_at = now();

  return new;
end;
$$;

revoke all on function private.handle_new_auth_user() from public, anon, authenticated, service_role;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- Only the server's secret key may call the provisioning RPCs.
grant usage on schema private to service_role;
grant select, insert, update, delete on table private.user_roles to service_role;

create or replace function public.provision_feeku_admin(
  target_user_id uuid,
  grantor_user_id uuid default null
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, private
as $$
begin
  if target_user_id is null then
    raise exception 'target_user_id is required';
  end if;

  delete from private.user_roles
  where user_id = target_user_id and role = 'admin';

  insert into private.user_roles (user_id, role, assigned_by)
  values (target_user_id, 'admin', grantor_user_id);
end;
$$;

revoke all on function public.provision_feeku_admin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.provision_feeku_admin(uuid, uuid) to service_role;

create or replace function public.revoke_feeku_admin(target_user_id uuid)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, private
as $$
begin
  if target_user_id is null then
    raise exception 'target_user_id is required';
  end if;

  delete from private.user_roles
  where user_id = target_user_id and role = 'admin';
end;
$$;

revoke all on function public.revoke_feeku_admin(uuid) from public, anon, authenticated;
grant execute on function public.revoke_feeku_admin(uuid) to service_role;
