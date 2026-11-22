-- Remove overlapping policies left by the initial Postgres bridge.
-- The newer *_owner policies are the single owner-scoped write policy.
DROP POLICY IF EXISTS transactions_insert_own ON public.transactions;
DROP POLICY IF EXISTS transactions_update_own ON public.transactions;
DROP POLICY IF EXISTS transactions_delete_own ON public.transactions;

DROP POLICY IF EXISTS transaction_items_insert_own ON public.transaction_items;
DROP POLICY IF EXISTS transaction_items_update_own ON public.transaction_items;
DROP POLICY IF EXISTS transaction_items_delete_own ON public.transaction_items;

-- Automatic margins are written only by the SECURITY DEFINER database trigger.
-- Clients may create/update/delete manual profit rows, never derived margin rows.
DROP POLICY IF EXISTS profits_insert_margin_own ON public.profits;
DROP POLICY IF EXISTS profits_delete_margin_own ON public.profits;
