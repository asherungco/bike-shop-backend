-- Mark unpaid online orders expired when a customer next checks their orders.
create or replace function public.expire_pending_online_orders(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_count integer := 0;
begin
  with expired_orders as (
    update public.orders
    set status = 'expired'
    where user_id = p_user_id
      and sales_channel = 'online'
      and status = 'pending_payment'
      and expires_at <= now()
    returning id
  ),
  history_rows as (
    insert into public.order_status_history(order_id,from_status,to_status,actor_id,actor_role)
    select id,'pending_payment','expired',null,'system'
    from expired_orders
    returning order_id
  )
  select count(*)::integer into v_count from history_rows;

  update public.payments p
  set status = 'expired'
  where p.status = 'pending'
    and p.order_id in (
      select id from public.orders
      where user_id = p_user_id
        and sales_channel = 'online'
        and status = 'expired'
        and expires_at <= now()
    );

  return v_count;
end;
$function$;

revoke all on function public.expire_pending_online_orders(uuid) from public,anon,authenticated;
grant execute on function public.expire_pending_online_orders(uuid) to service_role;
