
begin;

-- Private objects are not addressable by authenticated clients; keep schema usage server-only.
revoke usage on schema private from authenticated, anon, public;
grant usage on schema private to service_role;

-- Composite nullable references must null only their optional reference column,
-- never the non-null tenant/user key.
alter table public.payment_orders
  drop constraint payment_orders_transaction_owner_fk;
alter table public.payment_orders
  add constraint payment_orders_transaction_owner_fk
  foreign key (transaction_id, user_id)
  references public.transactions(id, user_id)
  on delete set null (transaction_id);

alter table public.payment_order_items
  drop constraint payment_order_items_product_owner_fk;
alter table public.payment_order_items
  add constraint payment_order_items_product_owner_fk
  foreign key (product_id, user_id)
  references public.products(id, user_id)
  on delete set null (product_id);

-- Indexes supporting composite and actor/provider foreign keys.
create index if not exists user_roles_assigned_by_idx
  on private.user_roles(assigned_by) where assigned_by is not null;
create index if not exists payment_events_payment_order_idx
  on private.payment_events(payment_order_id) where payment_order_id is not null;

create index if not exists activity_logs_actor_idx
  on public.activity_logs(actor_user_id) where actor_user_id is not null;

create index if not exists products_category_owner_idx
  on public.products(category_id, user_id);

create index if not exists transaction_items_transaction_owner_idx
  on public.transaction_items(transaction_id, user_id);
create index if not exists transaction_items_product_owner_idx
  on public.transaction_items(product_id, user_id);

create index if not exists profits_source_owner_idx
  on public.profits(source_transaction_id, user_id)
  where source_transaction_id is not null;

create index if not exists payment_orders_merchant_owner_idx
  on public.payment_orders(merchant_profile_id, user_id);
create index if not exists payment_orders_transaction_owner_idx
  on public.payment_orders(transaction_id, user_id)
  where transaction_id is not null;

create index if not exists payment_order_items_product_owner_idx
  on public.payment_order_items(product_id, user_id)
  where product_id is not null;
create index if not exists payment_order_items_user_idx
  on public.payment_order_items(user_id);

create index if not exists payment_settlements_merchant_owner_idx
  on public.payment_settlements(merchant_profile_id, user_id);

create index if not exists payment_settlement_items_order_owner_idx
  on public.payment_settlement_items(payment_order_id, user_id);
create index if not exists payment_settlement_items_settlement_owner_idx
  on public.payment_settlement_items(settlement_id, user_id);
create index if not exists payment_settlement_items_user_idx
  on public.payment_settlement_items(user_id);

create index if not exists payment_refunds_order_owner_idx
  on public.payment_refunds(payment_order_id, user_id);

-- Keep generated margin metadata synchronized when sale header details change.
drop trigger if exists transactions_sync_margin on public.transactions;
create trigger transactions_sync_margin
after insert or update of amount, entry_date, description, source
on public.transactions
for each row execute function private.sync_transaction_margin();

commit;
