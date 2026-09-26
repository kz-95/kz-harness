# Reserve stock before charging

Until now an order charged the customer first and took the stock afterwards, so a customer could pay for an item that had just sold out.

This change makes an order reserve its stock first:

- `src/reservations.js` is new. `reserve()` takes the stock and holds it for the order for 15 minutes by default, and tells the order's watchers; `confirm()` keeps it for good and `release()` puts it back.
- `src/orders.js` now reserves before it charges, and confirms the reservation once the payment has gone through.
- `src/stock.js` gained `take()` and `put()`, which change a level under the SKU's lock.

Shipping is unchanged: the price still comes from `src/shipping.js`.
