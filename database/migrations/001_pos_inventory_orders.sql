-- Review before applying. This migration has NOT been applied to the live project.
-- Adds POS metadata and database-atomic inventory operations.

alter table public.orders
  add column if not exists sales_channel text not null default 'online'
    check (sales_channel in ('online', 'pos')),
  add column if not exists fulfillment_type text not null default 'delivery'
    check (fulfillment_type in ('delivery', 'store_pickup')),
  add column if not exists cashier_id uuid references public.users(id),
  add column if not exists internal_notes text not null default '';

alter table public.payments drop constraint if exists payments_provider_check;
alter table public.payments add constraint payments_provider_check
  check (provider = any (array['paymongo'::text, 'maya'::text, 'cash'::text]));

create or replace function public.create_pos_sale(
  p_actor_id uuid,
  p_customer_id uuid,
  p_items jsonb,
  p_fulfillment_type text default 'store_pickup',
  p_notes text default ''
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_role text;
  v_order_id uuid;
  v_subtotal bigint := 0;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
begin
  select role into v_role from public.users where id = p_actor_id;
  if v_role not in ('admin', 'mechanic') then raise exception 'FORBIDDEN'; end if;
  if p_customer_id is null or not exists(select 1 from public.users where id=p_customer_id and role='customer') then
    raise exception 'CUSTOMER_REQUIRED';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items)=0 then raise exception 'INVALID_ITEMS'; end if;
  if p_fulfillment_type not in ('delivery','store_pickup') then raise exception 'INVALID_FULFILLMENT'; end if;

  -- Lock products in stable UUID order to avoid overselling and reduce deadlocks.
  for v_product in
    select p.* from public.products p
    join (select distinct (x->>'product_id')::uuid as product_id from jsonb_array_elements(p_items) x) i
      on i.product_id=p.id
    order by p.id for update
  loop
    if not v_product.is_active then raise exception 'PRODUCT_NOT_FOUND'; end if;
  end loop;

  insert into public.orders(user_id,status,subtotal_centavos,discount_centavos,total_centavos,
    expires_at,sales_channel,fulfillment_type,cashier_id,internal_notes)
  values(p_customer_id,'paid',0,0,0,now(),'pos',p_fulfillment_type,p_actor_id,coalesce(p_notes,''))
  returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if (v_item->>'quantity') is null or (v_item->>'quantity') !~ '^[1-9][0-9]*$' then raise exception 'INVALID_QUANTITY'; end if;
    v_qty := (v_item->>'quantity')::integer;
    select * into v_product from public.products where id=(v_item->>'product_id')::uuid for update;
    if not found or not v_product.is_active then raise exception 'PRODUCT_NOT_FOUND'; end if;
    if v_product.stock_qty < v_qty then raise exception 'INSUFFICIENT_STOCK'; end if;
    update public.products set stock_qty=stock_qty-v_qty where id=v_product.id;
    insert into public.order_items(order_id,product_id,product_name,unit_price_centavos,quantity)
      values(v_order_id,v_product.id,v_product.name,v_product.price_centavos,v_qty);
    v_subtotal := v_subtotal + (v_product.price_centavos::bigint * v_qty);
  end loop;

  update public.orders set subtotal_centavos=v_subtotal,total_centavos=v_subtotal where id=v_order_id;
  insert into public.payments(order_id,provider,provider_ref,status,amount_centavos,currency)
    values(v_order_id,'cash','POS-'||v_order_id::text,'paid',v_subtotal,'PHP');
  insert into public.order_status_history(order_id,from_status,to_status,actor_id,actor_role)
    values(v_order_id,null,'paid',p_actor_id,v_role);
  return jsonb_build_object('order_id',v_order_id,'status','paid','sales_channel','pos',
    'subtotal_centavos',v_subtotal,'total_centavos',v_subtotal,'currency','PHP');
end
$function$;

create or replace function public.adjust_product_stock(
  p_product_id uuid, p_new_qty integer, p_reason text, p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare v_old integer; v_role text;
begin
  select role into v_role from public.users where id=p_actor_id;
  if v_role <> 'admin' then raise exception 'FORBIDDEN'; end if;
  if p_new_qty < 0 or length(trim(p_reason)) < 3 then raise exception 'INVALID_ADJUSTMENT'; end if;
  select stock_qty into v_old from public.products where id=p_product_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  update public.products set stock_qty=p_new_qty where id=p_product_id;
  insert into public.stock_adjustments(product_id,previous_qty,new_qty,reason,actor_id)
    values(p_product_id,v_old,p_new_qty,trim(p_reason),p_actor_id);
  return jsonb_build_object('product_id',p_product_id,'previous_qty',v_old,'new_qty',p_new_qty);
end
$function$;

create or replace function public.set_order_status(
  p_order_id uuid, p_actor_id uuid, p_actor_role text, p_new_status text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare v_order public.orders%rowtype; v_role text;
begin
  select role into v_role from public.users where id=p_actor_id;
  if v_role is null or v_role <> p_actor_role then raise exception 'FORBIDDEN'; end if;
  if v_role not in ('admin','mechanic') then raise exception 'FORBIDDEN'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then return null; end if;
  if p_new_status='cancelled' then
    perform public.cancel_order(p_order_id,p_actor_id,v_role);
    return jsonb_build_object('id',p_order_id,'status','cancelled');
  end if;
  if not ((v_order.status='paid' and p_new_status='processing') or
          (v_order.status='processing' and p_new_status='ready') or
          (v_order.status='ready' and p_new_status='completed')) then
    raise exception 'INVALID_ORDER_TRANSITION';
  end if;
  update public.orders set status=p_new_status where id=p_order_id;
  insert into public.order_status_history(order_id,from_status,to_status,actor_id,actor_role)
    values(p_order_id,v_order.status,p_new_status,p_actor_id,v_role);
  return jsonb_build_object('id',p_order_id,'status',p_new_status);
end
$function$;

revoke all on function public.create_pos_sale(uuid,uuid,jsonb,text,text) from public, anon, authenticated;
revoke all on function public.adjust_product_stock(uuid,integer,text,uuid) from public, anon, authenticated;
revoke all on function public.set_order_status(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.create_pos_sale(uuid,uuid,jsonb,text,text) to service_role;
grant execute on function public.adjust_product_stock(uuid,integer,text,uuid) to service_role;
grant execute on function public.set_order_status(uuid,uuid,text,text) to service_role;
