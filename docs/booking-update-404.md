# Booking update 404 investigation

Read-only inspection of the configured database found:

| Record | ID | Company |
| --- | --- | --- |
| Booking (confirmed, not deleted) | `6adeff13207c3de734963594` | `6ad700afab202960782bd905` |
| Assigned vehicle (not deleted) | `6ac78c09d6f882bf6010f118` | `6a104377556803f5c265b8f3` |

The update route is registered. Its booking lookup requires the caller's company; its vehicle lookup requires that same company. These records cannot satisfy both checks. The original request's authenticated caller was unavailable, so the original response body/which lookup returned 404 was not observed. The persisted company mismatch is confirmed.

## Identity and authentication verification

The reported ID was found only in `bookings` when checked against `bookings`, `leads`, `handovers`, `maintenances`, and `vehicles`. The linked Lead is `6adc83816ee3d6fb5c9357ca`; it is not the edit identifier. It has the same company as the Booking.

The timeline formatter emits `booking._id`. Frontend `formatApiBooking` maps that to `id`; `bookingEditId(activeBooking)` sets `editingBookingId`; the modal receives that as `bookingId`. Both its GET `/bookings/:id` and PUT `/leads/booking-update/:id` use that exact prop. Neither the linked Lead ID, vehicle ID, booking code, nor optional self-reference `Booking.bookingId` is substituted.

`protect` verifies the bearer/cookie token, loads `User` by decoded `userId`, and rejects inactive/deleted users. Employee creation stores the owner in `User.createdBy`; the User schema has no company field. The editor resolves company from `user.company || user.createdBy || user._id`, supporting the actual employee-owner relationship and owner self-ID. It does not trust client-supplied company values. There is no cross-company SUPER_ADMIN exception for booking edits.

Authenticated malformed IDs return 400. Missing/deleted bookings and bookings outside the caller's company return the same generic 404 `Booking not found.` without foreign record details. Missing authentication returns 401 before record lookup. The historical relationship conflict is considered only after an owned booking has been found.

Both booking creation paths previously accepted a vehicle without checking its company, while assigning the booking to the user's company. That permitted the inconsistent relationship above. Existing shared dashboard feeds are not proof that a record belongs to the logged-in company.

The booking company currently has zero active vehicles. Reselection therefore needs a correctly registered company vehicle, or a reviewed correction of the historical ownership data. No automatic company transfer is safe to infer from this relationship alone.

## Changes

- Both creation paths now require company-owned vehicles. Lead conversion also requires an owned lead and validates the vehicle before saving customer changes.
- `GET /api/v1/bookings/vehicles` returns active company-owned choices, and the booking modal uses those choices for creation and editing.
- Edit GET does not populate another company's vehicle. It retains booking details and signals that a vehicle selection is required.
- Saving the unavailable saved vehicle returns a specific 409 without writing. Selecting an owned vehicle performs a normal persisted update. Other-company bookings and newly selected inaccessible vehicles remain 404.
- Omitted identity fields, pricing inputs, and pickup/drop charges retain saved values. Explicitly supplied identity fields keep their supported edit/clear behavior.
- Frontend failure logging includes status/code rather than the Axios request object, which can contain sensitive request data.

## Verification and remaining action

The existing PUT controller now merges only supported supplied customer/trip/service fields. Missing fields are retained; explicit optional empty strings clear those values. Booking and vehicle IDs are validated. Dates must be real calendar dates and pickup/drop times valid 12-hour or 24-hour times, with the drop after pickup. Changed vehicle/time windows are checked against other nonterminal bookings and scheduled/in-progress maintenance; exact adjoining booking times are permitted as in creation. Terminal/handed-over bookings cannot be edited through this endpoint.

Trip-only updates retain all saved payment values. Monetary inputs accept the existing flat aliases or supported nested payment fields. Saved vehicle rent is retained unless explicitly supplied, including when dates, vehicles, advances or discounts change. Totals are derived for explicitly changed monetary/service charges; the payment pre-save hook runs only for new or payment-modified records. The response remains `{ success, message, booking }`. No create, delete, replacement, or upsert is used in the update path.

Payment preservation additionally covers Cash, PhonePe, Razorpay, Mixed with split, and Mixed without split. Method/split-only edits do not recompute balance, collected amounts or status. Missing legacy payment fields are not written merely because Mongoose supplied hydration defaults. Mixed with omitted/empty split (or null split) retains saved data and never invents channel amounts. Partial split edits retain unspecified channels.

Fare edits apply component deltas to the saved total, preserving unitemized historical fare. Advances, discounts and deposits do not rebuild that total. Explicit advance/deposit corrections adjust collected amount by their delta, retaining any additional historical collections. Balance/status are recomputed only when their monetary dependencies change. Booking edits do not create, delete or alter PaymentHistory transactions or vehicle payment references; the dedicated collection lifecycle remains separate.

Isolated MongoDB tests reproduce the historical mismatch, assert that rejected writes change nothing, select an owned replacement, save, and reload. They also exercise company isolation, invalid/missing IDs, pricing, and record preservation. Existing booking/payment lifecycle and maintenance checks pass.

No live booking, vehicle, company, customer, payment, or maintenance record was migrated or modified during this investigation. To resolve this specific historical booking, its owner must select the correct company-owned vehicle. If ownership itself is wrong, an explicit, reviewed data correction is needed; the code does not infer or transfer ownership. Run the updated backend and reload the frontend before retrying. Authenticated live browser Save/reopen remains unverified.
