# Operations API

All endpoints use the base path `/api`. Protected endpoints require `Authorization: Bearer <token>`.

| Method | Endpoint | Access | Purpose |
|---|---|---|---|
| GET | `/orders` | Customer, mechanic, admin | Paginated order list; customer is restricted to own orders |
| PATCH | `/orders/:id/status` | Mechanic, admin | Advance or cancel an order |
| POST | `/pos/sales` | Mechanic, admin | Complete a cash POS sale |
| GET | `/inventory` | Mechanic, admin | View stock and low/out-of-stock summary |
| PATCH | `/inventory/adjust` | Admin | Set stock quantity and record reason |

## POS sale request
```json
{
  "customer_id": "existing-customer-uuid",
  "fulfillment_type": "store_pickup",
  "notes": "Walk-in counter sale",
  "items": [
    { "product_id": "product-uuid", "quantity": 1 },
    { "product_id": "another-product-uuid", "quantity": 2 }
  ]
}
```
The backend calculates the subtotal and total using current database prices. Do not send price values from the browser.

## Stock adjustment request
```json
{
  "product_id": "product-uuid",
  "new_qty": 24,
  "reason": "Physical inventory count"
}
```

## Order status request
```json
{ "status": "processing" }
```
Allowed forward transitions: `paid → processing → ready → completed`. Cancellation is also supported for eligible orders.
