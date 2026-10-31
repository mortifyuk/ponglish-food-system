# Ponglish Food — release and acceptance checklist

## Configuration
- [ ] Exact restaurant coordinates verified from a map pin.
- [ ] Fixed delivery fee and 10 km radius approved by Ponglish.
- [ ] Approved menu, options, prices, photos and sold-out rules loaded.
- [ ] Public HTTPS URL, TLS, backups and restore process verified.
- [ ] Admin token and database password rotated from sample values.
- [ ] Privacy notice, data retention and staff access agreed.

## Ordering tests
- [ ] Customer can browse and search the menu on mobile.
- [ ] Server calculates price from menu records, not browser-submitted prices.
- [ ] Multiple quantities, unavailable products, empty baskets and invalid quantities tested.
- [ ] Collection has zero delivery fee.
- [ ] Delivery inside 10 km applies exactly one fixed delivery fee.
- [ ] Delivery outside 10 km is rejected and customer is offered collection.
- [ ] Missing restaurant coordinates disables delivery safely.
- [ ] Customer details and order reference appear correctly in staff dashboard.
- [ ] Staff can move order through new, accepted, preparing, ready and completed.
- [ ] Cash orders remain `cash_due` until an authorised staff member confirms receipt.

## Kashier sandbox
- [ ] Test session creation returns a valid hosted checkout URL.
- [ ] Successful, failed and pending callbacks are tested.
- [ ] Invalid signatures are rejected.
- [ ] Duplicate webhook is idempotent.
- [ ] Amount, currency and order-reference mismatches do not mark an order paid.
- [ ] Browser redirect alone does not mark an order paid.
- [ ] Refund events are reconciled before any production refund workflow is offered.

## WhatsApp
- [ ] Meta webhook challenge verification passes.
- [ ] Invalid webhook signature is rejected when app secret is configured.
- [ ] Inbound message receives the menu link through Cloud API.
- [ ] Staff notification destination and number format are verified.
- [ ] Approved templates and 24-hour customer-service rules are checked.
- [ ] Retries, duplicate inbound messages, failed API calls and message status events are tested.

## Launch gate
- [ ] Run a staff pilot with test orders.
- [ ] Test database backup and restoration.
- [ ] Confirm alerts and manual fallback if internet or payment provider is unavailable.
- [ ] Obtain explicit Ponglish approval before switching Kashier from test to live.
