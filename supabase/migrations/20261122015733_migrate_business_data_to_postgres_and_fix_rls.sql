-- Move FeeKu business data behind PostgreSQL RLS and keep catalog-sale writes atomic.
-- The validation trigger must observe the final state after all transaction item
-- snapshots have been written by save_feeku_transaction/import RPCs.
DROP TRIGGER IF EXISTS transactions_catalog_sale_consistency ON public.transactions;
DROP TRIGGER IF EXISTS transaction_items_catalog_sale_consistency ON public.transaction_items;

CREATE CONSTRAINT TRIGGER transactions_catalog_sale_consistency
AFTER INSERT OR UPDATE ON public.transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION private.assert_catalog_sale_consistent();

CREATE CONSTRAINT TRIGGER transaction_items_catalog_sale_consistency
AFTER INSERT OR UPDATE OR DELETE ON public.transaction_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION private.assert_catalog_sale_consistent();

-- Margin rows are derived from immutable sale snapshots, not user input.
ALTER FUNCTION private.sync_transaction_margin() SECURITY DEFINER;
ALTER FUNCTION private.sync_transaction_margin() SET search_path = '';

-- Authenticated users can mutate only rows belonging to their own account.
-- The catalog-sale invariant is checked by deferred database triggers.
DROP POLICY IF EXISTS transactions_insert_owner ON public.transactions;
CREATE POLICY transactions_insert_owner
ON public.transactions
FOR INSERT TO authenticated
WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS transactions_update_owner ON public.transactions;
CREATE POLICY transactions_update_owner
ON public.transactions
FOR UPDATE TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS transactions_delete_owner ON public.transactions;
CREATE POLICY transactions_delete_owner
ON public.transactions
FOR DELETE TO authenticated
USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS transaction_items_insert_owner ON public.transaction_items;
CREATE POLICY transaction_items_insert_owner
ON public.transaction_items
FOR INSERT TO authenticated
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.transactions t
    WHERE t.id = transaction_items.transaction_id
      AND t.user_id = (SELECT auth.uid())
      AND t.source = 'catalog_sale'
      AND t.direction = 'Masuk'
  )
);

DROP POLICY IF EXISTS transaction_items_update_owner ON public.transaction_items;
CREATE POLICY transaction_items_update_owner
ON public.transaction_items
FOR UPDATE TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.transactions t
    WHERE t.id = transaction_items.transaction_id
      AND t.user_id = (SELECT auth.uid())
      AND t.source = 'catalog_sale'
      AND t.direction = 'Masuk'
  )
);

DROP POLICY IF EXISTS transaction_items_delete_owner ON public.transaction_items;
CREATE POLICY transaction_items_delete_owner
ON public.transaction_items
FOR DELETE TO authenticated
USING (user_id = (SELECT auth.uid()));

-- The previous website exposed IP address in the admin audit table. Preserve
-- that information in PostgreSQL instead of losing the audit field.
ALTER TABLE public.activity_logs
ADD COLUMN IF NOT EXISTS ip_address text;

COMMENT ON COLUMN public.activity_logs.ip_address IS
'Client IP captured by the trusted application server for audit purposes.';
