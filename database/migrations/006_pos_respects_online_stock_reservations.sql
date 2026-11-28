CREATE OR REPLACE FUNCTION public.create_pos_sale(p_actor_id uuid, p_customer_id uuid, p_items jsonb, p_fulfillment_type text DEFAULT 'store_pickup'::text, p_notes text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_role text;
  v_order_id uuid;
  v_subtotal bigint := 0;
  v_item jsonb;
  v_product public.products%rowtype;
  v_qty integer;
  v_reserved integer := 0;
BEGIN
  SELECT role INTO v_role FROM public.users WHERE id = p_actor_id;

  IF v_role IS NULL OR v_role NOT IN ('admin', 'employee', 'mechanic') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  IF p_customer_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = p_customer_id AND role = 'customer'
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_REQUIRED';
  END IF;

  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'INVALID_ITEMS';
  END IF;

  IF p_fulfillment_type NOT IN ('delivery', 'store_pickup') THEN
    RAISE EXCEPTION 'INVALID_FULFILLMENT';
  END IF;

  FOR v_product IN
    SELECT p.*
    FROM public.products p
    WHERE p.id IN (
      SELECT (x->>'product_id')::uuid
      FROM jsonb_array_elements(p_items) AS x
    )
    ORDER BY p.id
    FOR UPDATE
  LOOP
    IF NOT v_product.is_active THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;
  END LOOP;

  INSERT INTO public.orders(
    user_id, status, subtotal_centavos, discount_centavos, total_centavos,
    expires_at, sales_channel, fulfillment_type, cashier_id, internal_notes
  )
  VALUES (
    p_customer_id, 'paid', 0, 0, 0, now(), 'pos',
    p_fulfillment_type, p_actor_id, coalesce(p_notes, '')
  )
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    IF (v_item->>'product_id') IS NULL
      OR (v_item->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'INVALID_PRODUCT_ID';
    END IF;

    IF (v_item->>'quantity') IS NULL
      OR (v_item->>'quantity') !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;

    v_qty := (v_item->>'quantity')::integer;

    SELECT * INTO v_product
    FROM public.products
    WHERE id = (v_item->>'product_id')::uuid
    FOR UPDATE;

    IF NOT FOUND OR NOT v_product.is_active THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND';
    END IF;

    SELECT COALESCE(SUM(oi.quantity), 0)::integer INTO v_reserved
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE oi.product_id = v_product.id
      AND o.sales_channel = 'online'
      AND o.status = 'pending_payment'
      AND o.expires_at > now();

    IF v_product.stock_qty - v_reserved < v_qty THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK';
    END IF;

    UPDATE public.products
    SET stock_qty = stock_qty - v_qty
    WHERE id = v_product.id;

    INSERT INTO public.order_items(
      order_id, product_id, product_name, unit_price_centavos, quantity
    )
    VALUES (
      v_order_id, v_product.id, v_product.name, v_product.price_centavos, v_qty
    );

    v_subtotal := v_subtotal + (v_product.price_centavos::bigint * v_qty);
  END LOOP;

  UPDATE public.orders
  SET subtotal_centavos = v_subtotal, total_centavos = v_subtotal
  WHERE id = v_order_id;

  INSERT INTO public.payments(
    order_id, provider, provider_ref, status, amount_centavos, currency
  )
  VALUES (
    v_order_id, 'cash', 'POS-' || v_order_id::text, 'paid', v_subtotal, 'PHP'
  );

  INSERT INTO public.order_status_history(
    order_id, from_status, to_status, actor_id, actor_role
  )
  VALUES (v_order_id, NULL, 'paid', p_actor_id, v_role);

  RETURN jsonb_build_object(
    'order_id', v_order_id,
    'status', 'paid',
    'sales_channel', 'pos',
    'subtotal_centavos', v_subtotal,
    'total_centavos', v_subtotal,
    'currency', 'PHP'
  );
END
$function$;
