# Bike Shop Backend

Separate Express REST API for the Bike Shop PWA.

## Stack
- Node.js + Express
- Supabase PostgreSQL via `@supabase/supabase-js`
- bcrypt password hashing + JWT authentication
- Zod request validation
- Helmet, CORS and rate limiting

## Important database compatibility note
The current database has a `public.users` table with `email`, `password_hash`,
`full_name`, and roles constrained to `customer`, `mechanic`, and `admin`.
This starter therefore implements authentication against that existing table.
It does **not** assume that `public.users.id` is linked to `auth.users`.
A later reviewed migration can move authentication to Supabase Auth and add
an explicit `employee` role. Do not run both authentication systems at once.

All database access is server-side. The Supabase service-role key must never
be placed in the React frontend or committed to Git. RLS is enabled without
policies in the current project; the service key bypasses RLS, so every
protected endpoint must enforce authorization in this API.

## Setup
1. Install Node.js 20 or newer.
2. Extract this folder and open a terminal inside it.
3. Run `npm install`.
4. Copy `.env.example` to `.env`.
5. Fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and a long random
   `JWT_SECRET`.
6. Run `npm run dev`.
7. Open `http://localhost:5000/api/health`.

## API base
`http://localhost:5000/api`

### Public
- `GET /health`
- `GET /products`
- `GET /products/:id`
- `GET /categories`

### Authentication
- `POST /auth/register` — customer registration only
- `POST /auth/login`
- `GET /auth/me` — requires `Authorization: Bearer <token>`

### Admin
- `POST /products`
- `PATCH /products/:id`
- `DELETE /products/:id` — soft-deactivates product
- `POST /categories`

### Staff access
The current database's `mechanic` role is treated as staff only for the
repair/operations role group later. It is not silently renamed to employee.

## Example registration
```json
{
  "email": "customer@example.com",
  "password": "StrongPassword123!",
  "full_name": "Sample Customer"
}
```

## Example login
```json
{
  "email": "customer@example.com",
  "password": "StrongPassword123!"
}
```

## Product filters
`GET /products?search=road&kind=bike&category_id=1&page=1&limit=12`

Prices are stored in `price_centavos` (integer). Keep amounts as integers
in the backend; format to PHP pesos in the frontend.

## Next backend milestones
1. Review/apply a non-destructive migration for employee role and profile/auth
   design.
2. Add order creation with server-side price calculation and stock-safe
   transactions.
3. Add employee POS and shared inventory operations.
4. Add repair booking endpoints using existing booking/slot functions.
5. Add PayMongo/Maya sandbox checkout and verified idempotent webhooks.
6. Add Gemini recommendations grounded in actual product rows.
7. Add Swagger/OpenAPI and automated tests.
