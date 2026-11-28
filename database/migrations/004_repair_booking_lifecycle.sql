-- Customer repair booking lifecycle with final repair cost and pay-at-shop collection.
begin;

alter table public.bookings
  add column if not exists bike_description text not null default '',
  add column if not exists problem_description text not null default '',
  add column if not exists final_cost_centavos integer,
  add column if not exists payment_status text not null default 'unpaid',
  add column if not exists payment_method text not null default 'cash_at_shop';

update public.bookings b
set status = 'pending',
    held_until = coalesce(s.starts_at, b.held_until)
from public.service_slots s
where b.slot_id = s.id and b.status = 'held';

alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status = any (array['pending','confirmed','in_repair','ready_for_pickup','completed','cancelled','expired']::text[]));
alter table public.bookings add constraint bookings_final_cost_check
  check (final_cost_centavos is null or final_cost_centavos >= 0);
alter table public.bookings add constraint bookings_payment_status_check
  check (payment_status = any (array['unpaid','paid']::text[]));
alter table public.bookings add constraint bookings_payment_method_check
  check (payment_method = any (array['cash_at_shop']::text[]));

create table if not exists public.booking_status_history (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_id uuid references public.users(id),
  actor_role text,
  created_at timestamptz not null default now()
);
create index if not exists booking_status_history_booking_created_idx
  on public.booking_status_history(booking_id, created_at desc);
create index if not exists booking_status_history_actor_id_idx
  on public.booking_status_history(actor_id);
alter table public.booking_status_history enable row level security;

create or replace function public.create_repair_booking(
  p_slot_id uuid,
  p_user_id uuid,
  p_bike_id uuid,
  p_bike_description text,
  p_problem_description text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_role text;
  v_slot public.service_slots%rowtype;
  v_taken integer;
  v_booking_id uuid;
begin
  select role into v_role from public.users where id = p_user_id;
  if v_role is distinct from 'customer' then raise exception 'CUSTOMER_ONLY'; end if;
  if length(trim(coalesce(p_bike_description, ''))) < 3 then raise exception 'BIKE_DETAILS_REQUIRED'; end if;
  if length(trim(coalesce(p_problem_description, ''))) < 10 then raise exception 'PROBLEM_DESCRIPTION_REQUIRED'; end if;

  if p_bike_id is not null and not exists (
    select 1 from public.bikes where id = p_bike_id and user_id = p_user_id
  ) then raise exception 'BIKE_NOT_FOUND'; end if;

  select * into v_slot from public.service_slots where id = p_slot_id for update;
  if not found then raise exception 'SLOT_NOT_FOUND'; end if;
  if v_slot.starts_at < now() + interval '2 hours' then raise exception 'SLOT_CLOSED'; end if;
  if not exists (select 1 from public.service_types where id = v_slot.service_type_id and is_active = true) then
    raise exception 'SERVICE_UNAVAILABLE';
  end if;

  select count(*) into v_taken from public.bookings
  where slot_id = p_slot_id and status in ('pending','confirmed','in_repair','ready_for_pickup');
  if v_taken >= v_slot.capacity then raise exception 'SLOT_FULL'; end if;

  insert into public.bookings (
    slot_id,user_id,bike_id,status,held_until,bike_description,problem_description,payment_status,payment_method
  )
  values (
    p_slot_id,p_user_id,p_bike_id,'pending',v_slot.starts_at,
    trim(p_bike_description),trim(p_problem_description),'unpaid','cash_at_shop'
  )
  returning id into v_booking_id;

  insert into public.booking_status_history(booking_id,from_status,to_status,actor_id,actor_role)
  values(v_booking_id,null,'pending',p_user_id,'customer');
  return v_booking_id;
end;
$function$;

create or replace function public.update_repair_booking_status(
  p_booking_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_new_status text,
  p_final_cost_centavos integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_current_role text;
  v_booking public.bookings%rowtype;
begin
  select role into v_current_role from public.users where id = p_actor_id;
  if v_current_role is null or v_current_role <> p_actor_role or p_actor_role not in ('admin','employee','mechanic') then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;

  if p_new_status = 'confirmed' and v_booking.status = 'pending' then
    null;
  elsif p_new_status = 'in_repair' and v_booking.status = 'confirmed' then
    null;
  elsif p_new_status = 'ready_for_pickup' and v_booking.status = 'in_repair' then
    if p_final_cost_centavos is null or p_final_cost_centavos < 0 then raise exception 'FINAL_COST_REQUIRED'; end if;
  elsif p_new_status = 'completed' and v_booking.status = 'ready_for_pickup' then
    if v_booking.payment_status <> 'paid' then raise exception 'REPAIR_PAYMENT_REQUIRED'; end if;
  elsif p_new_status = 'cancelled' and v_booking.status in ('pending','confirmed') then
    null;
  else
    raise exception 'INVALID_BOOKING_TRANSITION';
  end if;

  update public.bookings
  set status = p_new_status,
      final_cost_centavos = case when p_new_status = 'ready_for_pickup' then p_final_cost_centavos else final_cost_centavos end
  where id = v_booking.id;

  insert into public.booking_status_history(booking_id,from_status,to_status,actor_id,actor_role)
  values(v_booking.id,v_booking.status,p_new_status,p_actor_id,p_actor_role);

  return jsonb_build_object('id',v_booking.id,'status',p_new_status);
end;
$function$;

create or replace function public.cancel_repair_booking(p_booking_id uuid,p_actor_id uuid,p_actor_role text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_current_role text;
  v_booking public.bookings%rowtype;
begin
  select role into v_current_role from public.users where id = p_actor_id;
  if v_current_role is null or v_current_role <> p_actor_role then raise exception 'FORBIDDEN'; end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;

  if p_actor_role = 'customer' then
    if v_booking.user_id <> p_actor_id or v_booking.status not in ('pending','confirmed') then raise exception 'INVALID_BOOKING_TRANSITION'; end if;
  elsif p_actor_role in ('admin','employee','mechanic') then
    if v_booking.status not in ('pending','confirmed') then raise exception 'INVALID_BOOKING_TRANSITION'; end if;
  else
    raise exception 'FORBIDDEN';
  end if;

  update public.bookings set status = 'cancelled' where id = v_booking.id;
  insert into public.booking_status_history(booking_id,from_status,to_status,actor_id,actor_role)
  values(v_booking.id,v_booking.status,'cancelled',p_actor_id,p_actor_role);
  return jsonb_build_object('id',v_booking.id,'status','cancelled');
end;
$function$;

create or replace function public.mark_repair_payment_received(p_booking_id uuid,p_actor_id uuid,p_actor_role text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_current_role text;
  v_booking public.bookings%rowtype;
begin
  select role into v_current_role from public.users where id = p_actor_id;
  if v_current_role is null or v_current_role <> p_actor_role or p_actor_role not in ('admin','employee','mechanic') then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_booking.status <> 'ready_for_pickup' or v_booking.final_cost_centavos is null then
    raise exception 'REPAIR_NOT_READY_FOR_PAYMENT';
  end if;

  update public.bookings set payment_status='paid',payment_method='cash_at_shop' where id=v_booking.id;
  return jsonb_build_object('id',v_booking.id,'payment_status','paid');
end;
$function$;

revoke all on function public.create_repair_booking(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.create_repair_booking(uuid,uuid,uuid,text,text) to service_role;
revoke all on function public.update_repair_booking_status(uuid,uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.update_repair_booking_status(uuid,uuid,text,text,integer) to service_role;
revoke all on function public.cancel_repair_booking(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.cancel_repair_booking(uuid,uuid,text) to service_role;
revoke all on function public.mark_repair_payment_received(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.mark_repair_payment_received(uuid,uuid,text) to service_role;

commit;
