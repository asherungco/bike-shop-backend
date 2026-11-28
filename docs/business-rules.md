# Bike Shop API — Business Rules

## Existing role mapping
The current database role constraint permits `customer`, `mechanic`, and `admin`. Until a separately reviewed migration introduces an `employee` role, the backend treats `mechanic` as the staff role for POS and order fulfillment. Do not issue mechanic accounts to users who should not have staff access.

## POS and inventory
- Only `admin` and `mechanic` may create POS sales or view inventory.
- Only `admin` may make manual stock adjustments.
- POS requires an existing customer account because `orders.user_id` is non-nullable in the current schema. A dedicated walk-in customer workflow is a future schema decision.
- Prices and product names are read from the database. Client-submitted prices are ignored.
- POS stock decrements happen inside one PostgreSQL transaction through `create_pos_sale`; if any item is invalid or short on stock, the whole sale rolls back.
- POS records a paid cash payment, order channel `pos`, cashier, fulfillment type, and status history.
- Stock adjustments lock the product row and create a `stock_adjustments` audit record.

## Order status
- Staff may move `paid → processing → ready → completed`.
- Staff may cancel an eligible order through the existing `cancel_order` database function, which restores stock and updates related records.
- Customers can view only their own orders. Staff can view all orders.

## Error behavior
- Invalid input: HTTP 400.
- Missing product/order: HTTP 404.
- Insufficient stock, duplicate/conflicting transition: HTTP 409.
- Missing/invalid token: HTTP 401.
- Wrong role: HTTP 403.

## Important limitations
- The migration in `database/migrations/001_pos_inventory_orders.sql` is not applied automatically. Apply it only after reviewing and backing up the database.
- Online cart checkout, coupon redemption, PayMongo hosted checkout/webhook verification, and AI recommendations are not yet implemented in this backend increment.
