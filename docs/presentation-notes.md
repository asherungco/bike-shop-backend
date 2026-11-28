# Backend Presentation Notes (Demo Guide)

## 60-second explanation
“Our backend is built with Node.js and Express. React does not connect directly to the database. It calls versioned REST endpoints, and the backend validates requests, checks the JWT, checks the current role from the database, and applies business rules. Supabase PostgreSQL stores the catalog, users, orders, payments, and inventory. The service-role key stays in the backend environment and is never sent to the browser.”

## Explain the POS inventory transaction
“When a staff member submits a POS sale, the browser sends only product IDs and quantities. The server does not trust prices from the browser. A PostgreSQL function locks the selected product rows, checks that products are active and stock is sufficient, reads the authoritative prices, creates the order and order items, records a cash payment, and deducts stock in one transaction. If any item fails validation or does not have enough stock, PostgreSQL rolls back the whole transaction. This prevents partial sales and overselling.”

## Explain role-based access
“Every protected request needs a bearer token. The middleware verifies the JWT and then re-reads the user record so an old token cannot preserve a role that has changed. Customers can only see their own orders. The current database has `admin`, `mechanic`, and `customer` roles, so this implementation uses `mechanic` as the existing staff role for POS and order processing.”

## Live demo sequence
1. Start backend: `npm run dev`.
2. Open `GET http://localhost:5000/api/health`.
3. Log in as a staff account using `POST /api/auth/login`; copy the returned token.
4. In Postman, set `token` and run `GET /api/inventory`.
5. Run `POST /api/pos/sales` with a real customer UUID and product UUID from the database. Use a product with stock greater than zero.
6. Run `GET /api/inventory` again and show the decreased stock.
7. Try a quantity greater than available stock to show the transaction rejects the sale.
8. Use an ordinary customer token on the inventory endpoint to demonstrate HTTP 403.

## Be honest during the defense
The SQL migration must be reviewed and applied before the new POS/inventory/order endpoints can run against Supabase. This package has not applied that migration. Do not claim the POS endpoint is live until the migration is applied and a real end-to-end test succeeds. Payment gateway checkout/webhook and Gemini AI integration are still pending.
