
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

create type public.transaction_direction as enum ('Masuk', 'Keluar');
create type public.product_pricing_method as enum ('manual', 'markup', 'target_margin', 'fixed_profit');
create type public.transaction_source as enum ('manual', 'catalog_sale');
create type public.profit_source as enum ('manual', 'transaction_margin');
create type public.merchant_onboarding_status as enum (
  'not_started', 'pending_verification', 'needs_information',
  'active', 'rejected', 'suspended'
);
create type public.payment_order_status as enum (
  'pending', 'processing', 'paid', 'expired', 'failed',
  'cancelled', 'partially_refunded', 'refunded'
);
create type public.settlement_status as enum ('pending', 'processing', 'settled', 'failed', 'reversed');
create type public.refund_status as enum ('requested', 'pending', 'succeeded', 'failed', 'cancelled');

create table private.user_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin')),
  assigned_at timestamptz not null default now(),
  assigned_by uuid references auth.users(id) on delete set null,
  primary key (user_id, role)
);
alter table private.user_roles enable row level security;
revoke all on private.user_roles from public, anon, authenticated;
grant select, insert, update, delete on private.user_roles to service_role;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 100),
  phone_e164 text,
  whatsapp_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_phone_e164_format check (
    phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
  )
);
create unique index profiles_phone_e164_unique
  on public.profiles(phone_e164) where phone_e164 is not null;

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  description text check (description is null or char_length(description) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create unique index categories_user_name_ci
  on public.categories(user_id, lower(trim(name)));

create table public.products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category_id uuid not null,
  name text not null check (char_length(trim(name)) between 1 and 150),
  sku text check (sku is null or char_length(sku) <= 80),
  unit_name text not null default 'pcs' check (char_length(trim(unit_name)) between 1 and 24),
  stock_quantity numeric(14,3) not null default 0 check (stock_quantity >= 0),
  reserved_quantity numeric(14,3) not null default 0 check (
    reserved_quantity >= 0 and reserved_quantity <= stock_quantity
  ),
  unit_cost numeric(18,2) not null default 0 check (unit_cost >= 0),
  sale_price numeric(18,2) not null default 0 check (sale_price >= 0),
  pricing_method public.product_pricing_method not null default 'manual',
  pricing_value numeric(18,4) not null default 0 check (pricing_value >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  constraint products_category_owner_fk
    foreign key (category_id, user_id)
    references public.categories(id, user_id) on delete restrict,
  constraint products_sku_user_unique unique (user_id, sku),
  constraint products_margin_below_100 check (
    pricing_method <> 'target_margin' or pricing_value < 100
  )
);
create index products_user_category_idx on public.products(user_id, category_id);
create index products_user_active_idx on public.products(user_id, is_active);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null default current_date,
  description text not null check (char_length(trim(description)) between 1 and 200),
  direction public.transaction_direction not null,
  amount numeric(18,2) not null default 0 check (amount >= 0),
  source public.transaction_source not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  constraint transactions_manual_amount_positive check (
    source = 'catalog_sale' or amount > 0
  ),
  constraint transactions_catalog_sale_is_income check (
    source <> 'catalog_sale' or direction = 'Masuk'
  )
);
create index transactions_user_date_idx on public.transactions(user_id, entry_date desc, created_at desc);
create index transactions_user_source_idx on public.transactions(user_id, source);

create table public.transaction_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid not null,
  product_id uuid not null,
  product_name_snapshot text not null check (char_length(product_name_snapshot) between 1 and 150),
  sku_snapshot text,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_cost_snapshot numeric(18,2) not null check (unit_cost_snapshot >= 0),
  sale_price_snapshot numeric(18,2) not null check (sale_price_snapshot >= 0),
  line_total numeric(18,2) generated always as (round(quantity * sale_price_snapshot, 2)) stored,
  cost_total numeric(18,2) generated always as (round(quantity * unit_cost_snapshot, 2)) stored,
  profit_amount numeric(18,2) generated always as (
    round(quantity * (sale_price_snapshot - unit_cost_snapshot), 2)
  ) stored,
  created_at timestamptz not null default now(),
  constraint transaction_items_transaction_owner_fk
    foreign key (transaction_id, user_id)
    references public.transactions(id, user_id) on delete cascade,
  constraint transaction_items_product_owner_fk
    foreign key (product_id, user_id)
    references public.products(id, user_id) on delete restrict
);
create index transaction_items_user_transaction_idx on public.transaction_items(user_id, transaction_id);
create index transaction_items_product_idx on public.transaction_items(product_id);

create table public.profits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null default current_date,
  description text not null check (char_length(trim(description)) between 1 and 200),
  direction public.transaction_direction not null,
  amount numeric(18,2) not null check (amount > 0),
  source public.profit_source not null default 'manual',
  source_transaction_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profits_source_consistency check (
    (source = 'manual' and source_transaction_id is null)
    or (source = 'transaction_margin' and source_transaction_id is not null)
  ),
  constraint profits_source_transaction_owner_fk
    foreign key (source_transaction_id, user_id)
    references public.transactions(id, user_id) on delete cascade
);
create unique index profits_one_margin_per_transaction
  on public.profits(source_transaction_id) where source_transaction_id is not null;
create index profits_user_date_idx on public.profits(user_id, entry_date desc);

create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null check (char_length(action) between 1 and 100),
  entity_type text not null check (char_length(entity_type) between 1 and 80),
  entity_id text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);
create index activity_logs_user_created_idx on public.activity_logs(user_id, created_at desc);
create index activity_logs_action_created_idx on public.activity_logs(action, created_at desc);

-- Merchant records deliberately contain no bank account credentials or verification documents.
create table public.merchant_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  business_name text not null check (char_length(trim(business_name)) between 1 and 160),
  business_category text,
  country_code char(2) not null default 'ID' check (country_code = 'ID'),
  currency_code char(3) not null default 'IDR' check (currency_code = 'IDR'),
  onboarding_status public.merchant_onboarding_status not null default 'not_started',
  payments_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create index merchant_profiles_status_idx on public.merchant_profiles(onboarding_status);

-- Provider account references and provider-specific configuration stay in a non-exposed schema.
create table private.merchant_provider_accounts (
  id uuid primary key default gen_random_uuid(),
  merchant_profile_id uuid not null unique references public.merchant_profiles(id) on delete cascade,
  provider_code text not null check (provider_code ~ '^[a-z][a-z0-9_-]{1,39}$'),
  provider_merchant_ref text not null,
  provider_account_status text not null default 'pending',
  safe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_metadata) = 'object'),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_code, provider_merchant_ref)
);
alter table private.merchant_provider_accounts enable row level security;
revoke all on private.merchant_provider_accounts from public, anon, authenticated;
grant select, insert, update, delete on private.merchant_provider_accounts to service_role;

create table public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  merchant_profile_id uuid not null,
  transaction_id uuid,
  order_reference text not null unique,
  provider_code text not null check (provider_code ~ '^[a-z][a-z0-9_-]{1,39}$'),
  provider_payment_ref text,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 160),
  payment_method text not null default 'qris' check (payment_method in ('qris')),
  amount numeric(18,2) not null check (amount > 0),
  currency_code char(3) not null default 'IDR' check (currency_code = 'IDR'),
  status public.payment_order_status not null default 'pending',
  qr_payload text,
  qr_image_url text,
  checkout_url text,
  expires_at timestamptz,
  paid_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, idempotency_key),
  unique (provider_code, provider_payment_ref),
  constraint payment_orders_merchant_owner_fk
    foreign key (merchant_profile_id, user_id)
    references public.merchant_profiles(id, user_id) on delete restrict,
  constraint payment_orders_transaction_owner_fk
    foreign key (transaction_id, user_id)
    references public.transactions(id, user_id) on delete set null
);
create index payment_orders_user_created_idx on public.payment_orders(user_id, created_at desc);
create index payment_orders_user_status_idx on public.payment_orders(user_id, status);
create index payment_orders_merchant_created_idx on public.payment_orders(merchant_profile_id, created_at desc);

create table public.payment_order_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  payment_order_id uuid not null,
  product_id uuid,
  product_name_snapshot text not null check (char_length(product_name_snapshot) between 1 and 150),
  sku_snapshot text,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_cost_snapshot numeric(18,2) not null check (unit_cost_snapshot >= 0),
  sale_price_snapshot numeric(18,2) not null check (sale_price_snapshot >= 0),
  line_total numeric(18,2) generated always as (round(quantity * sale_price_snapshot, 2)) stored,
  cost_total numeric(18,2) generated always as (round(quantity * unit_cost_snapshot, 2)) stored,
  created_at timestamptz not null default now(),
  constraint payment_order_items_order_owner_fk
    foreign key (payment_order_id, user_id)
    references public.payment_orders(id, user_id) on delete cascade,
  constraint payment_order_items_product_owner_fk
    foreign key (product_id, user_id)
    references public.products(id, user_id) on delete set null
);
create index payment_order_items_order_idx on public.payment_order_items(payment_order_id, user_id);

create table public.payment_settlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  merchant_profile_id uuid not null,
  provider_code text not null check (provider_code ~ '^[a-z][a-z0-9_-]{1,39}$'),
  provider_settlement_ref text not null,
  gross_amount numeric(18,2) not null check (gross_amount >= 0),
  fee_amount numeric(18,2) not null default 0 check (fee_amount >= 0),
  net_amount numeric(18,2) not null check (net_amount >= 0),
  currency_code char(3) not null default 'IDR' check (currency_code = 'IDR'),
  status public.settlement_status not null default 'pending',
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (provider_code, provider_settlement_ref),
  constraint payment_settlements_amounts_balance check (gross_amount = fee_amount + net_amount),
  constraint payment_settlements_merchant_owner_fk
    foreign key (merchant_profile_id, user_id)
    references public.merchant_profiles(id, user_id) on delete restrict
);
create index payment_settlements_user_date_idx on public.payment_settlements(user_id, created_at desc);

create table public.payment_settlement_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  settlement_id uuid not null,
  payment_order_id uuid not null,
  gross_amount numeric(18,2) not null check (gross_amount >= 0),
  fee_amount numeric(18,2) not null check (fee_amount >= 0),
  net_amount numeric(18,2) not null check (net_amount >= 0),
  created_at timestamptz not null default now(),
  unique (settlement_id, payment_order_id),
  constraint payment_settlement_items_amounts_balance check (gross_amount = fee_amount + net_amount),
  constraint payment_settlement_items_settlement_owner_fk
    foreign key (settlement_id, user_id)
    references public.payment_settlements(id, user_id) on delete cascade,
  constraint payment_settlement_items_order_owner_fk
    foreign key (payment_order_id, user_id)
    references public.payment_orders(id, user_id) on delete restrict
);
create index payment_settlement_items_order_idx on public.payment_settlement_items(payment_order_id);

create table public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  payment_order_id uuid not null,
  provider_code text not null check (provider_code ~ '^[a-z][a-z0-9_-]{1,39}$'),
  provider_refund_ref text,
  amount numeric(18,2) not null check (amount > 0),
  status public.refund_status not null default 'requested',
  reason text check (reason is null or char_length(reason) <= 500),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint payment_refunds_order_owner_fk
    foreign key (payment_order_id, user_id)
    references public.payment_orders(id, user_id) on delete restrict,
  unique (provider_code, provider_refund_ref)
);
create index payment_refunds_user_created_idx on public.payment_refunds(user_id, created_at desc);

-- Raw webhook bodies and provider event identifiers are private server-side data.
create table private.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider_code text not null check (provider_code ~ '^[a-z][a-z0-9_-]{1,39}$'),
  provider_event_id text not null,
  payment_order_id uuid references public.payment_orders(id) on delete set null,
  event_type text not null,
  signature_verified boolean not null default false,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text,
  unique (provider_code, provider_event_id)
);
alter table private.payment_events enable row level security;
revoke all on private.payment_events from public, anon, authenticated;
grant select, insert, update, delete on private.payment_events to service_role;

-- Updated timestamp helper is private and is only invoked by triggers.
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.set_updated_at() from public, anon, authenticated, service_role;

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function private.set_updated_at();
create trigger categories_set_updated_at before update on public.categories
for each row execute function private.set_updated_at();
create trigger products_set_updated_at before update on public.products
for each row execute function private.set_updated_at();
create trigger transactions_set_updated_at before update on public.transactions
for each row execute function private.set_updated_at();
create trigger profits_set_updated_at before update on public.profits
for each row execute function private.set_updated_at();
create trigger merchant_profiles_set_updated_at before update on public.merchant_profiles
for each row execute function private.set_updated_at();
create trigger payment_orders_set_updated_at before update on public.payment_orders
for each row execute function private.set_updated_at();
create trigger merchant_provider_accounts_set_updated_at before update on private.merchant_provider_accounts
for each row execute function private.set_updated_at();

-- A sale line can only belong to an incoming catalog-sale transaction.
create or replace function private.validate_transaction_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_source public.transaction_source;
  v_direction public.transaction_direction;
begin
  if tg_op = 'UPDATE' and (
    new.transaction_id is distinct from old.transaction_id
    or new.user_id is distinct from old.user_id
  ) then
    raise exception 'Transaction item cannot be moved between transactions or users'
      using errcode = '23514';
  end if;

  select t.source, t.direction
    into v_source, v_direction
    from public.transactions t
   where t.id = new.transaction_id
     and t.user_id = new.user_id;

  if not found or v_source <> 'catalog_sale' or v_direction <> 'Masuk' then
    raise exception 'Transaction items require an incoming catalog sale'
      using errcode = '23514';
  end if;

  return new;
end;
$$;
revoke all on function private.validate_transaction_item() from public, anon, authenticated, service_role;

create trigger transaction_items_validate
before insert or update on public.transaction_items
for each row execute function private.validate_transaction_item();

-- Stock movement is performed atomically with catalog sale item changes.
create or replace function private.apply_transaction_item_stock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.products
       set stock_quantity = stock_quantity - new.quantity,
           updated_at = now()
     where id = new.product_id
       and user_id = new.user_id
       and stock_quantity - reserved_quantity >= new.quantity;
    if not found then
      raise exception 'Insufficient available stock for product %', new.product_id
        using errcode = '23514';
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    update public.products
       set stock_quantity = stock_quantity + old.quantity,
           updated_at = now()
     where id = old.product_id and user_id = old.user_id;

    update public.products
       set stock_quantity = stock_quantity - new.quantity,
           updated_at = now()
     where id = new.product_id
       and user_id = new.user_id
       and stock_quantity - reserved_quantity >= new.quantity;
    if not found then
      raise exception 'Insufficient available stock for product %', new.product_id
        using errcode = '23514';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    update public.products
       set stock_quantity = stock_quantity + old.quantity,
           updated_at = now()
     where id = old.product_id and user_id = old.user_id;
    return old;
  end if;
  return null;
end;
$$;
revoke all on function private.apply_transaction_item_stock() from public, anon, authenticated, service_role;

create trigger transaction_items_apply_stock
before insert or update or delete on public.transaction_items
for each row execute function private.apply_transaction_item_stock();

-- Keep the transaction header amount and automated margin aligned with its item snapshots.
create or replace function private.sync_catalog_sale_totals()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_transaction_id uuid;
  v_total numeric(18,2);
begin
  if tg_op = 'DELETE' then
    v_transaction_id := old.transaction_id;
  else
    v_transaction_id := new.transaction_id;
  end if;

  select coalesce(sum(ti.line_total), 0)::numeric(18,2)
    into v_total
    from public.transaction_items ti
   where ti.transaction_id = v_transaction_id;

  update public.transactions t
     set amount = v_total,
         updated_at = now()
   where t.id = v_transaction_id
     and t.source = 'catalog_sale';

  return null;
end;
$$;
revoke all on function private.sync_catalog_sale_totals() from public, anon, authenticated, service_role;

create trigger transaction_items_sync_total
after insert or update or delete on public.transaction_items
for each row execute function private.sync_catalog_sale_totals();

create or replace function private.sync_transaction_margin()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_margin numeric(18,2);
begin
  if new.source <> 'catalog_sale' then
    return new;
  end if;

  select coalesce(sum(ti.profit_amount), 0)::numeric(18,2)
    into v_margin
    from public.transaction_items ti
   where ti.transaction_id = new.id
     and ti.user_id = new.user_id;

  delete from public.profits p
   where p.source = 'transaction_margin'
     and p.source_transaction_id = new.id
     and p.user_id = new.user_id;

  if v_margin > 0 then
    insert into public.profits (
      user_id, entry_date, description, direction, amount, source, source_transaction_id
    ) values (
      new.user_id, new.entry_date, 'Margin penjualan katalog: ' || new.description,
      'Masuk', v_margin, 'transaction_margin', new.id
    );
  elsif v_margin < 0 then
    insert into public.profits (
      user_id, entry_date, description, direction, amount, source, source_transaction_id
    ) values (
      new.user_id, new.entry_date, 'Kerugian penjualan katalog: ' || new.description,
      'Keluar', abs(v_margin), 'transaction_margin', new.id
    );
  end if;

  return new;
end;
$$;
revoke all on function private.sync_transaction_margin() from public, anon, authenticated, service_role;

create trigger transactions_sync_margin
after update of amount on public.transactions
for each row execute function private.sync_transaction_margin();

-- Deferred validation ensures catalog-sale headers and item snapshots commit consistently.
create or replace function private.assert_catalog_sale_consistent()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_transaction_id uuid;
  v_user_id uuid;
  v_source public.transaction_source;
  v_amount numeric(18,2);
  v_item_count bigint;
  v_items_total numeric(18,2);
begin
  if tg_table_name = 'transactions' then
    if tg_op = 'DELETE' then
      v_transaction_id := old.id;
    else
      v_transaction_id := new.id;
    end if;
  else
    if tg_op = 'DELETE' then
      v_transaction_id := old.transaction_id;
    else
      v_transaction_id := new.transaction_id;
    end if;
  end if;

  select t.user_id, t.source, t.amount
    into v_user_id, v_source, v_amount
    from public.transactions t
   where t.id = v_transaction_id;

  if not found or v_source <> 'catalog_sale' then
    return null;
  end if;

  select count(*), coalesce(sum(ti.line_total), 0)::numeric(18,2)
    into v_item_count, v_items_total
    from public.transaction_items ti
   where ti.transaction_id = v_transaction_id
     and ti.user_id = v_user_id;

  if v_item_count = 0 or v_items_total <> v_amount then
    raise exception 'Catalog sale % must contain items whose total matches its transaction amount', v_transaction_id
      using errcode = '23514';
  end if;

  return null;
end;
$$;
revoke all on function private.assert_catalog_sale_consistent() from public, anon, authenticated, service_role;

create constraint trigger transactions_catalog_sale_consistency
after insert or update on public.transactions
deferrable initially deferred
for each row execute function private.assert_catalog_sale_consistent();

create constraint trigger transaction_items_catalog_sale_consistency
after insert or update or delete on public.transaction_items
deferrable initially deferred
for each row execute function private.assert_catalog_sale_consistent();

-- All application tables use RLS. Admin-wide access is intentionally not granted here;
-- privileged/admin reporting will be implemented later through audited backend paths.
alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.transactions enable row level security;
alter table public.transaction_items enable row level security;
alter table public.profits enable row level security;
alter table public.activity_logs enable row level security;
alter table public.merchant_profiles enable row level security;
alter table public.payment_orders enable row level security;
alter table public.payment_order_items enable row level security;
alter table public.payment_settlements enable row level security;
alter table public.payment_settlement_items enable row level security;
alter table public.payment_refunds enable row level security;

create policy profiles_select_own on public.profiles
for select to authenticated
using ((select auth.uid()) = id);

create policy profiles_update_own on public.profiles
for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy categories_select_own on public.categories
for select to authenticated
using ((select auth.uid()) = user_id);
create policy categories_insert_own on public.categories
for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy categories_update_own on public.categories
for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy categories_delete_own on public.categories
for delete to authenticated
using ((select auth.uid()) = user_id);

create policy products_select_own on public.products
for select to authenticated
using ((select auth.uid()) = user_id);
create policy products_insert_own on public.products
for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy products_update_own on public.products
for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy products_delete_own on public.products
for delete to authenticated
using ((select auth.uid()) = user_id);

create policy transactions_select_own on public.transactions
for select to authenticated
using ((select auth.uid()) = user_id);
create policy transactions_insert_manual_own on public.transactions
for insert to authenticated
with check ((select auth.uid()) = user_id and source = 'manual');
create policy transactions_update_manual_own on public.transactions
for update to authenticated
using ((select auth.uid()) = user_id and source = 'manual')
with check ((select auth.uid()) = user_id and source = 'manual');
create policy transactions_delete_manual_own on public.transactions
for delete to authenticated
using ((select auth.uid()) = user_id and source = 'manual');

create policy transaction_items_select_own on public.transaction_items
for select to authenticated
using ((select auth.uid()) = user_id);

create policy profits_select_own on public.profits
for select to authenticated
using ((select auth.uid()) = user_id);
create policy profits_insert_manual_own on public.profits
for insert to authenticated
with check ((select auth.uid()) = user_id and source = 'manual' and source_transaction_id is null);
create policy profits_update_manual_own on public.profits
for update to authenticated
using ((select auth.uid()) = user_id and source = 'manual' and source_transaction_id is null)
with check ((select auth.uid()) = user_id and source = 'manual' and source_transaction_id is null);
create policy profits_delete_manual_own on public.profits
for delete to authenticated
using ((select auth.uid()) = user_id and source = 'manual' and source_transaction_id is null);

create policy activity_logs_select_own on public.activity_logs
for select to authenticated
using ((select auth.uid()) = user_id);

create policy merchant_profiles_select_own on public.merchant_profiles
for select to authenticated
using ((select auth.uid()) = user_id);

create policy payment_orders_select_own on public.payment_orders
for select to authenticated
using ((select auth.uid()) = user_id);
create policy payment_order_items_select_own on public.payment_order_items
for select to authenticated
using ((select auth.uid()) = user_id);

create policy payment_settlements_select_own on public.payment_settlements
for select to authenticated
using ((select auth.uid()) = user_id);
create policy payment_settlement_items_select_own on public.payment_settlement_items
for select to authenticated
using ((select auth.uid()) = user_id);
create policy payment_refunds_select_own on public.payment_refunds
for select to authenticated
using ((select auth.uid()) = user_id);

-- Remove broad defaults; explicitly grant only the operations needed by authenticated users.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

grant select, insert, update, delete on public.categories to authenticated;
grant select, insert, update, delete on public.products to authenticated;

grant select on public.transactions to authenticated;
grant insert (user_id, entry_date, description, direction, amount) on public.transactions to authenticated;
grant update (entry_date, description, direction, amount) on public.transactions to authenticated;
grant delete on public.transactions to authenticated;

grant select on public.transaction_items to authenticated;

grant select on public.profits to authenticated;
grant insert (user_id, entry_date, description, direction, amount) on public.profits to authenticated;
grant update (entry_date, description, direction, amount) on public.profits to authenticated;
grant delete on public.profits to authenticated;

grant select on public.activity_logs to authenticated;
grant select on public.merchant_profiles to authenticated;
grant select on public.payment_orders to authenticated;
grant select on public.payment_order_items to authenticated;
grant select on public.payment_settlements to authenticated;
grant select on public.payment_settlement_items to authenticated;
grant select on public.payment_refunds to authenticated;

grant all privileges on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema private revoke all on tables from public, anon, authenticated;
alter default privileges in schema private grant all on tables to service_role;

comment on schema private is 'Internal FeeKu schema. Not exposed through the Supabase Data API.';
comment on table public.profiles is 'Private user profile fields; WhatsApp verification fields are server-managed.';
comment on table private.user_roles is 'Privileged role assignments. No direct client access; provisioned by trusted server tooling.';
comment on table public.transaction_items is 'Immutable sale snapshots; stock and automated margin are maintained by database triggers.';
comment on table public.merchant_profiles is 'Merchant onboarding status only. Bank credentials and identity documents remain with the payment provider.';
comment on table public.payment_orders is 'Provider-neutral payment order records. Created and updated by trusted server-side code only.';
comment on table private.payment_events is 'Private payment webhook inbox; raw provider events are not exposed to clients.';

commit;
