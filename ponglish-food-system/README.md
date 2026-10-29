# Ponglish Food Ordering — deployable MVP

A mobile-friendly ordering application with a PostgreSQL order store, staff dashboard, fixed delivery fee, 10 km circular delivery rule, cash-on-delivery/collection tracking, Kashier hosted checkout integration, and Meta WhatsApp Cloud API webhook starter.

## Important release status

This is an integration-ready MVP, not yet a live production launch. Before accepting real orders, set the exact restaurant coordinates and public HTTPS URL, review the imported menu/prices against the original images and confirm with the restaurant, configure the official WhatsApp Business Cloud API account and Kashier credentials, and complete end-to-end sandbox and security tests. The menu is imported from the seven supplied menu images into `menu-data.json` (EGP prices, descriptions and categories). Product prices are listed before the stated 14% sales tax; confirm local tax treatment with the restaurant/accountant before launch.

## Quick deployment (Portainer / Docker Compose)

1. Copy `.env.example` to `.env`.
2. Generate strong unique values for `POSTGRES_PASSWORD`, `ADMIN_TOKEN` (at least 32 characters) and `WHATSAPP_VERIFY_TOKEN`.
3. Set `PUBLIC_BASE_URL` to the final public HTTPS address, e.g. `https://orders.your-domain.example`. Set `DATABASE_URL` to use the same database username/password/database as the `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` values; URL-encode any reserved characters in the password.
4. Set `RESTAURANT_LAT` and `RESTAURANT_LNG` to the exact restaurant pin. Delivery remains unavailable until these are configured. Delivery eligibility is calculated server-side with Haversine distance; the default radius is 10 km and the delivery fee is fixed within that radius.
5. Update `DELIVERY_FEE` to the agreed fee in EGP. `CURRENCY` defaults to EGP.
6. In Portainer, create a Stack from this folder/repository, make sure the `.env` values are supplied as stack environment variables, and deploy. For a local folder, use the Compose file and `.env` file together.
7. Put the app behind HTTPS using the reverse proxy. Do not expose PostgreSQL publicly. Restrict access to `/admin.html` operationally if possible.
8. Open `/admin.html`, enter the `ADMIN_TOKEN`, review the imported menu, verify the 14% tax handling before launch, and run a test order. The menu import runs on startup and updates seeded menu item details while preserving availability toggles.

The Compose file publishes the app on port 3000 by default. Change `APP_PORT` if needed. Persistent PostgreSQL data is stored in the named Docker volume `ponglish_pgdata`. Back it up before upgrades.

## Routes

- `/` — visual menu and customer checkout
- `/admin.html` — staff dashboard (Bearer token from `ADMIN_TOKEN`)
- `/health` — application/database health
- `/api/menu` — available menu items
- `/api/orders` — create an order; all prices and totals are recalculated on the server
- `/api/admin/orders` — protected order queue
- `/api/admin/menu/:id` — protected availability/price/name updates
- `/webhooks/whatsapp` — Meta webhook verification and inbound message starter
- `/webhooks/kashier` — signed, idempotent payment callback handler

## WhatsApp setup

Use Meta's official WhatsApp Cloud API, not WhatsApp Web automation. Configure the callback URL as `https://YOUR_DOMAIN/webhooks/whatsapp`, set `WHATSAPP_VERIFY_TOKEN` to the same verification token in Meta, and configure `WHATSAPP_APP_SECRET`, `WHATSAPP_TOKEN`, and `WHATSAPP_PHONE_NUMBER_ID`. `RESTAURANT_PHONE` is the WhatsApp destination used for staff order alerts; use the international number format expected by the Cloud API. Ensure the business has the required messaging permissions and approved templates where required. The initial webhook responds to inbound text with the visual menu link; full interactive conversational ordering and approved templates are a subsequent integration milestone.

## Kashier setup

Set `KASHIER_MODE=test` and use test credentials first. Configure merchant ID, API key and secret key. Configure the Payment API Key separately for webhook signature verification. The callback URL is `https://YOUR_DOMAIN/webhooks/kashier`. The server only changes an order to paid after a valid HMAC signature, a matching order reference, amount and currency. Do not treat the browser redirect as proof of payment. Verify the request/response fields against your merchant account's current Kashier docs and run success, failure, duplicate callback and mismatched amount/currency tests before switching `KASHIER_MODE=live`.

## Delivery pin

The customer must enter the street address and tap the map to select a pin. The backend computes distance from the restaurant coordinates and rejects deliveries outside the configured radius. The map uses Leaflet and OpenStreetMap tiles, which require internet access. The map defaults to the Hurghada area only as a visual starting point; it is not a substitute for configuring the exact restaurant coordinates.

## Security and operations checklist

- Use HTTPS and keep `.env` out of Git; rotate any credentials accidentally exposed.
- Use a long random admin token and share it only with authorised staff.
- Restrict network access to the database; keep backups and test restoration.
- Verify every imported product, spelling, price and description against the supplied menu images before pilot. The source menu says prices exclude 14% sales tax; the MVP currently does not add a separate tax line automatically.
- Confirm cash is marked paid only after staff actually receive it.
- Configure monitoring and backups, and run the acceptance tests in `RELEASE-CHECKLIST.md`.
- Set data retention, privacy notice and staff access procedures before launch.

## Known MVP limits

- Menu products are imported from the supplied menu images. Individual product photos are not supplied, so the interface uses text descriptions rather than assigning whole menu-sheet images to individual products.
- No address autocomplete/geocoding: the customer selects a map pin.
- WhatsApp Cloud API webhook starter and staff alert are included, but the full multi-step interactive WhatsApp bot, message templates, retries/job queue and conversation persistence need completing/testing with Ponglish's live account.
- Kashier is coded for hosted payment sessions and verified webhook updates, but must be validated against the merchant's credentials and sandbox payloads.
- No POS, printer, driver dispatch, loyalty programme or automated refunds.

## Automated checks

Run `npm test` for the built-in delivery-distance unit tests. Run `node --check server.js` to check server syntax. Full API integration tests require the Docker Compose database and configured provider sandbox credentials.
