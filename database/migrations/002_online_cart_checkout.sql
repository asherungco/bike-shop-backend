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
  v_item record;
begin
  if p_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select role into v_role from public.users where id = p_user_id;
  if v_role is distinct from 'customer' then
    raise exception 'CUSTOMER_ONLY';
  end if;

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
     where user_id = p_user_id and idempotency_key = p_idempotency_key
     limit 1;
    if v_order_id is not null then
      return jsonb_build_object('order_id', v_order_id, 'reused', true);
    end if;
  end if;

  select id into v_cart_id
    from public.carts
   where user_id = p_user_id
   for update;

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
    if v_item.stock_qty < v_item.quantity then raise exception 'INSUFFICIENT_STOCK'; end if;
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
    now() + interval '30 minutes',
    case when p_fulfillment_type = 'delivery' then trim(p_shipping_name) else null end,
    case when p_fulfillment_type = 'delivery' then trim(p_shipping_phone) else null end,
    case when p_fulfillment_type = 'delivery' then trim(p_shipping_address) else null end,
    case when p_fulfillment_type = 'delivery' then trim(p_shipping_city) else null end,
    p_shipping_fee_centavos, 0, 'online', p_fulfillment_type, p_idempotency_key
  )
  returning id into v_order_id;

  for v_item in
    select ci.product_id, ci.quantity, p.name, p.price_centavos
      from public.cart_items ci
      join public.products p on p.id = ci.product_id
     where ci.cart_id = v_cart_id
     order by p.id
  loop
    update public.products set stock_qty = stock_qty - v_item.quantity
     where id = v_item.product_id;

    insert into public.order_items (
      order_id, product_id, product_name, unit_price_centavos, quantity
    )
    values (v_order_id, v_item.product_id, v_item.name, v_item.price_centavos, v_item.quantity);
  end loop;

  insert into public.order_status_history (
    order_id, from_status, to_status, actor_id, actor_role
  )
  values (v_order_id, null, 'pending_payment', p_user_id, 'customer');

  delete from public.cart_items where cart_id = v_cart_id;
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
    'expires_at', now() + interval '30 minutes',
    'reused', false
  );
end;
$function$;

revoke all on function public.create_online_order(uuid,text,text,text,text,text,integer,text) from public, anon, authenticated;
grant execute on function public.create_online_order(uuid,text,text,text,text,text,integer,text) to service_role;
