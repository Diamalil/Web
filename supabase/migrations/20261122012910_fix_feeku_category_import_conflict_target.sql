CREATE UNIQUE INDEX IF NOT EXISTS categories_user_name_uidx
ON public.categories(user_id, name);
