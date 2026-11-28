-- Customer checkout stock lifecycle.
-- Pending checkouts reserve availability but do not reduce on-hand stock.
-- Stock is deducted only after Maya's payment has been verified.

begin;

-- Repair unpaid orders created by the previous implementation.
with expired_items as (
  select oi.product_id, sum(oi.quantity)::integer as quantity
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  where o.status = 'pending_payment'
    and o.sales_channel = 'online'
    and o.expires_at <= now()
  group by oi.product_id
)
update public.products p
set stock_qty = p.stock_qty + expired_items.quantity
from expired_items
where p.id = expired_items.product_id;

update public.payments p
set status = 'expired'
from public.orders o
where p.order_id = o.id
  and o.status = 'pending_payment'
  and o.sales_channel = 'online'
  and o.expires_at <= now()
  and p.status = 'pending';

insert into public.order_status_history(order_id, from_status, to_status, actor_id, actor_role)
select o.id, o.status, 'expired', null, 'system'
from public.orders o
where o.status = 'pending_payment'
  and o.sales_channel = 'online'
  and o.expires_at <= now();

update public.orders
set status = 'expired'
where status = 'pending_payment'
  and sales_channel = 'online'
  and expires_at <= now();

create or replace function public.create_online_order(
  p_user_id uuid,
  p_fulfillment_type text default 'delivery',
  p_shipping_name text default null,
  p_shipping_phone text default null,
  p_shipping_address text default null,
  p_shipping_city text default null,
  p_shipping_fee_centavos integer default 0,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_role text;
  v_cart_id uuid;
  v_order_id uuid;
  v_subtotal bigint := 0;
  v_total bigint := 0;
  v_reserved integer := 0;
  v_expires_at timestamptz := now() + interval '30 minutes';
  v_item record;
begin
  if p_user_id is null then raise exception 'AUTH_REQUIRED'; end if;

  select role into v_role from public.users where id = p_user_id;
  if v_role is distinct from 'customer' then raise exception 'CUSTOMER_ONLY'; end if;

  if p_fulfillment_type not in ('delivery', 'store_pickup') then
    raise exception 'INVALID_FULFILLMENT';
  end if;
  if p_shipping_fee_centavos is null or p_shipping_fee_centavos < 0 then
    raise exception 'INVALID_SHIPPING_FEE';
  end if;
  if p_fulfillment_type = 'delivery'
     and (nullif(trim(coalesce(p_shipping_name, '')), '') is null
       or nullif(trim(coalesce(p_shipping_phone, '')), '') is null
       or nullif(trim(coalesce(p_shipping_address, '')), '') is null
       or nullif(trim(coalesce(p_shipping_city, '')), '') is null) then
    raise exception 'SHIPPING_DETAILS_REQUIRED';
  end if;
  if p_fulfillment_type = 'store_pickup' and p_shipping_fee_centavos <> 0 then
    raise exception 'PICKUP_SHIPPING_FEE_MUST_BE_ZERO';
  end if;

  if p_idempotency_key is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_idempotency_key, 0));
    select id into v_order_id
    from public.orders
    where user_id = p_user_id
      and idempotency_key = p_idempotency_key
      and status = 'pending_payment'
      and expires_at > now()
    limit 1;
    if v_order_id is not null then
      return jsonb_build_object('order_id', v_order_id, 'reused', true);
    end if;
  end if;

  if exists (
    select 1 from public.orders
    where user_id = p_user_id and sales_channel = 'online'
      and status = 'pending_payment' and expires_at > now()
  ) then
    raise exception 'PENDING_CHECKOUT_EXISTS';
  end if;

  select id into v_cart_id
  from public.carts where user_id = p_user_id for update;
  if v_cart_id is null or not exists (
    select 1 from public.cart_items where cart_id = v_cart_id
  ) then
    raise exception 'CART_EMPTY';
  end if;

  perform p.id
  from public.products p
  join public.cart_items ci on ci.product_id = p.id
  where ci.cart_id = v_cart_id
  order by p.id
  for update of p;

  for v_item in
    select ci.product_id, ci.quantity, p.name, p.price_centavos, p.stock_qty, p.is_active
    from public.cart_items ci
    join public.products p on p.id = ci.product_id
    where ci.cart_id = v_cart_id
    order by p.id
  loop
    if not v_item.is_active then raise exception 'PRODUCT_UNAVAILABLE'; end if;

    select coalesce(sum(oi.quantity), 0)::integer into v_reserved
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where oi.product_id = v_item.product_id
      and o.sales_channel = 'online'
      and o.status = 'pending_payment'
      and o.expires_at > now();

    if v_item.stock_qty - v_reserved < v_item.quantity then
      raise exception 'INSUFFICIENT_STOCK';
    end if;

    v_subtotal := v_subtotal + (v_item.price_centavos::bigint * v_item.quantity);
  end loop;

  v_total := v_subtotal + p_shipping_fee_centavos;
  if v_subtotal > 2147483647 or v_total > 2147483647 then
    raise exception 'ORDER_TOTAL_TOO_LARGE';
  end if;

  insert into public.orders (
    user_id, status, subtotal_centavos, discount_centavos, total_centavos,
    expires_at, shipping_name, shipping_phone, shipping_address, shipping_city,
    shipping_fee_centavos, service_fee_centavos, sales_channel, fulfillment_type,
    idempotency_key
  )
  values (
    p_user_id, 'pending_payment', v_subtotal::integer, 0, v_total::integer,
    v_expires_at,
    case when p_fulfillment_type = 'delivery' then trim(p_shipping_name) else null end,
    case when p_fulfillment_type = 'delivery' then trim(p_shipping_phone) else null end,
    case when p_fulfillment_type = 'delivery' then trim(p_shipping_address) else null end,
    case when p_fulfillment_type = 'delivery' then trim(p_shipping_city) else null end,
    p_shipping_fee_centavos, 0, 'online', p_fulfillment_type, p_idempotency_key
  )
  returning id into v_order_id;

  insert into public.order_items(order_id, product_id, product_name, unit_price_centavos, quantity)
  select v_order_id, p.id, p.name, p.price_centavos, ci.quantity
  from public.cart_items ci
  join public.products p on p.id = ci.product_id
  where ci.cart_id = v_cart_id;

  insert into public.order_status_history(order_id, from_status, to_status, actor_id, actor_role)
  values (v_order_id, null, 'pending_payment', p_user_id, 'customer');

  update public.carts set updated_at = now() where id = v_cart_id;

  return jsonb_build_object(
    'order_id', v_order_id,
    'status', 'pending_payment',
    'sales_channel', 'online',
    'fulfillment_type', p_fulfillment_type,
    'subtotal_centavos', v_subtotal,
    'shipping_fee_centavos', p_shipping_fee_centavos,
    'total_centavos', v_total,
    'currency', 'PHP',
    'expires_at', v_expires_at,
    'reused', false
  );
end;
$function$;

create or replace function public.finalize_online_order_payment(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order public.orders%rowtype;
  v_reserved integer := 0;
  v_item record;
  v_cart_id uuid;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status = 'paid' then
    return jsonb_build_object('accepted', true, 'status', 'paid', 'reused', true);
  end if;
  if v_order.status <> 'pending_payment' or v_order.sales_channel <> 'online' then
    return jsonb_build_object('accepted', false, 'status', v_order.status);
  end if;

  perform p.id
  from public.products p
  join public.order_items oi on oi.product_id = p.id
  where oi.order_id = v_order.id
  order by p.id
  for update of p;

  for v_item in
    select oi.product_id, oi.quantity, p.stock_qty
    from public.order_items oi
    join public.products p on p.id = oi.product_id
    where oi.order_id = v_order.id
    order by p.id
  loop
    select coalesce(sum(oi2.quantity), 0)::integer into v_reserved
    from public.order_items oi2
    join public.orders o2 on o2.id = oi2.order_id
    where oi2.product_id = v_item.product_id
      and o2.sales_channel = 'online'
      and o2.status = 'pending_payment'
      and o2.expires_at > now()
      and o2.id <> v_order.id;

    if v_item.stock_qty - v_reserved < v_item.quantity then
      raise exception 'INSUFFICIENT_STOCK_AT_PAYMENT';
    end if;
  end loop;

  update public.products p
  set stock_qty = p.stock_qty - oi.quantity
  from public.order_items oi
  where oi.order_id = v_order.id and oi.product_id = p.id;

  update public.orders set status = 'paid'
  where id = v_order.id and status = 'pending_payment';

  insert into public.order_status_history(order_id, from_status, to_status, actor_id, actor_role)
  values (v_order.id, 'pending_payment', 'paid', null, 'system');

  select id into v_cart_id from public.carts where user_id = v_order.user_id;
  if v_cart_id is not null then
    update public.cart_items ci
    set quantity = ci.quantity - oi.quantity
    from public.order_items oi
    where ci.cart_id = v_cart_id
      and oi.order_id = v_order.id
      and ci.product_id = oi.product_id
      and ci.quantity > oi.quantity;

    delete from public.cart_items ci
    using public.order_items oi
    where ci.cart_id = v_cart_id
      and oi.order_id = v_order.id
      and ci.product_id = oi.product_id
      and ci.quantity <= oi.quantity;

    update public.carts set updated_at = now() where id = v_cart_id;
  end if;

  return jsonb_build_object('accepted', true, 'status', 'paid', 'reused', false);
end;
$function$;

create or replace function public.mark_online_order_payment_failed(
  p_order_id uuid,
  p_target_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order public.orders%rowtype;
begin
  if p_target_status not in ('cancelled', 'expired') then
    raise exception 'INVALID_PAYMENT_FAILURE_STATUS';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;

  if v_order.status <> 'pending_payment' then
    return jsonb_build_object('accepted', false, 'status', v_order.status);
  end if;

  update public.orders set status = p_target_status where id = v_order.id;
  insert into public.order_status_history(order_id, from_status, to_status, actor_id, actor_role)
  values (v_order.id, 'pending_payment', p_target_status, null, 'system');

  return jsonb_build_object('accepted', true, 'status', p_target_status);
end;
$function$;

create or replace function public.cancel_order(
  p_order_id uuid,
  p_actor_id uuid,
  p_actor_role text
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order public.orders%rowtype;
  v_current_role text;
begin
  select role into v_current_role from public.users where id = p_actor_id;
  if v_current_role is null or v_current_role <> p_actor_role then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;

  if p_actor_role = 'customer' then
    if v_order.user_id <> p_actor_id or v_order.status <> 'paid' or v_order.sales_channel <> 'online' then
      raise exception 'INVALID_TRANSITION';
    end if;
  elsif p_actor_role in ('admin', 'employee', 'mechanic') then
    if v_order.status not in ('paid', 'processing') then
      raise exception 'INVALID_TRANSITION';
    end if;
  else
    raise exception 'FORBIDDEN';
  end if;

  update public.products p
  set stock_qty = p.stock_qty + oi.quantity
  from public.order_items oi
  where oi.order_id = v_order.id and oi.product_id = p.id;

  update public.orders set status = 'cancelled' where id = v_order.id;
  insert into public.order_status_history(order_id, from_status, to_status, actor_id, actor_role)
  values (v_order.id, v_order.status, 'cancelled', p_actor_id, p_actor_role);

  update public.bookings set status = 'cancelled'
  where order_id = v_order.id and status in ('held', 'confirmed');

  update public.payments set status = 'expired'
  where order_id = v_order.id and status = 'pending';

  if v_order.coupon_id is not null then
    with deleted_redemptions as (
      delete from public.coupon_redemptions where order_id = v_order.id returning 1
    )
    update public.coupons
    set times_used = greatest(times_used - (select count(*) from deleted_redemptions)::integer, 0)
    where id = v_order.coupon_id;
  end if;
end;
$function$;

revoke all on function public.create_online_order(uuid,text,text,text,text,text,integer,text) from public, anon, authenticated;
grant execute on function public.create_online_order(uuid,text,text,text,text,text,integer,text) to service_role;
revoke all on function public.finalize_online_order_payment(uuid) from public, anon, authenticated;
grant execute on function public.finalize_online_order_payment(uuid) to service_role;
revoke all on function public.mark_online_order_payment_failed(uuid,text) from public, anon, authenticated;
grant execute on function public.mark_online_order_payment_failed(uuid,text) to service_role;
revoke all on function public.cancel_order(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.cancel_order(uuid,uuid,text) to service_role;

commit;
