-- Track manual refunds after a paid order is cancelled.
begin;

alter table public.payments
  add column if not exists refund_status text not null default 'not_required',
  add column if not exists refund_completed_at timestamptz,
  add column if not exists refund_completed_by uuid references public.users(id);

alter table public.payments drop constraint if exists payments_refund_status_check;
alter table public.payments
  add constraint payments_refund_status_check
  check (refund_status = any (array['not_required','pending','refunded']::text[]));

create index if not exists payments_refund_completed_by_idx
  on public.payments(refund_completed_by);

CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid, p_actor_id uuid, p_actor_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order public.orders%rowtype;
  v_current_role text;
begin
  select role into v_current_role
  from public.users
  where id = p_actor_id;

  if v_current_role is null or v_current_role <> p_actor_role then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

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
  where oi.order_id = v_order.id
    and oi.product_id = p.id;

  update public.orders set status = 'cancelled' where id = v_order.id;

  insert into public.order_status_history(order_id, from_status, to_status, actor_id, actor_role)
  values (v_order.id, v_order.status, 'cancelled', p_actor_id, p_actor_role);

  update public.bookings
  set status = 'cancelled'
  where order_id = v_order.id
    and status in ('held', 'confirmed');

  update public.payments
  set status = 'expired'
  where order_id = v_order.id
    and status = 'pending';

  update public.payments
  set refund_status = 'pending'
  where order_id = v_order.id
    and provider = 'maya'
    and status = 'paid'
    and refund_status = 'not_required';

  if v_order.coupon_id is not null then
    with deleted_redemptions as (
      delete from public.coupon_redemptions
      where order_id = v_order.id
      returning 1
    )
    update public.coupons
    set times_used = greatest(
      times_used - (select count(*) from deleted_redemptions)::integer,
      0
    )
    where id = v_order.coupon_id;
  end if;
end;
$function$;

create or replace function public.mark_order_refund_completed(
  p_payment_id uuid,
  p_actor_id uuid,
  p_actor_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_role text;
  v_payment public.payments%rowtype;
begin
  select role into v_role from public.users where id = p_actor_id;
  if v_role is distinct from p_actor_role or p_actor_role <> 'admin' then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
  if v_payment.refund_status <> 'pending' then raise exception 'REFUND_NOT_PENDING'; end if;

  update public.payments
  set refund_status = 'refunded',
      refund_completed_at = now(),
      refund_completed_by = p_actor_id
  where id = v_payment.id;

  return jsonb_build_object('payment_id',v_payment.id,'refund_status','refunded');
end;
$function$;

revoke all on function public.mark_order_refund_completed(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.mark_order_refund_completed(uuid,uuid,text) to service_role;

commit;
