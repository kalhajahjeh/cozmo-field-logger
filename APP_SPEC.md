# APP_SPEC — Cozmo Field Logger

Field data-collection web app for a 4-person GJU simulation team observing service stations at Simply Cozmo – Dabouq 1. Every tap is a timestamped event; nothing is typed from scratch; no data may be lost.

**Hard deadline:** usable on 4 Nov 2026 at 17:00 (Asia/Amman). The app is used only if it passes the dry run (Acceptance tests). Otherwise the team uses paper sheets.

## 1. Platform
- Single-page web app: plain HTML, CSS, JavaScript. No framework, no build step.
- Hosted on GitHub Pages (HTTPS).
- Installed on iPhone via Safari → Share → Add to Home Screen.
  - Include a web app manifest and `apple-mobile-web-app-capable` meta tags.
  - Include a service worker that caches the app shell, so the app opens with no network.
- All four users are on iPhone. Test only on iOS Safari and Home Screen mode.

## 2. Data flow
1. Every tap writes one event to IndexedDB immediately, before any UI update completes. Use localStorage as a fallback.
2. A sync queue POSTs unsynced events in batches to a Google Apps Script web app. The script appends them to a Google Sheet.
   - Retry with backoff when offline.
   - Run on app open, every 30 s, and on the `online` event.
3. The Apps Script returns the `event_id`s it stored. The client marks only those as synced.
4. The server ignores any `event_id` it already has, so retries never create duplicates.
5. Phone-side backup: an "Export CSV" button shares or downloads all events for the session through the iOS share sheet.
6. A status bar is always visible: `Saved on phone: N · Synced: M · Pending: K`, plus an online/offline dot.

## 3. Time
- Timestamps come from the device clock (iPhones sync to network time). Store them as ISO 8601 with milliseconds and the +03:00 offset.
- Also store `elapsed_s`: seconds since session start, 1 decimal place.
- No stopwatch sync is needed.

## 4. Screens

### 4.1 Session setup
- **Observer name:** remembered between sessions.
- **Station:** one of Deli, Butchery, Bakery, Checkout service, Checkout arrivals.
- **Counter stations:** one-line description for each of E1, E2, E3 (e.g., "red cap, left scale"). Allow adding E4.
- **Checkout service:** lane numbers for the 2 lanes watched.
- **Checkout arrivals:** lane numbers currently open.
- **Start session** creates `session_id` and logs `session_start`.

### 4.2 Counter mode (Deli, Butchery, Bakery)
- A large **ARRIVAL** button sits at the bottom, in thumb reach. Each tap creates customer #n with an `arrival` event.
- Open customers appear as cards, oldest first. Each card has:
  - **START:** then one tap to pick E1/E2/E3. Logs `service_start` with the employee.
  - **END:** logs `service_end`.
  - **Order:** S / W / P / M (sliced or cut to order / weighed, not cut / pre-packed handed over / mix).
  - **Items:** − / + stepper.
  - **X:** interruption counter. Each tap logs `interruption`.
  - **Balk:** only before START. Closes the card.
  - **Renege:** only before START. Closes the card.
- **Sampling hint:** highlight the card the observer should time next. That is the first customer who arrived after the observer's last completed service.
- An arrival-only card (never started) is valid. It can be dismissed as "not timed".

### 4.3 Checkout service mode
- Two lane columns. Each column has a **JOIN** button that creates a customer in that lane.
- Each card has:
  - **START:** first item scanned.
  - **END:** payment complete.
  - **Basket:** H / B / T (hand-carried / basket / trolley).
  - **Pay:** C / K (cash / card or phone).
  - **X:** interruption counter.

### 4.4 Checkout arrivals mode
- One large button per open lane, plus **Other lane**. Each tap logs a `join` event with the lane.
- Lane open/close toggles log `lane_open` / `lane_close` events.
- Show a live count per lane for the current 5-minute bin.

### 4.5 Snapshot (all stations)
- Every 10 minutes from session start, a full-screen prompt appears. iOS web apps can't vibrate, so it must be visually obvious.
- The prompt has steppers for:
  - Queue length. For checkout this is per lane, e.g. 3/1/4/0.
  - Employees serving.
  - Employees present, not serving.
  - Registers open (checkout only).
- **Save** logs one `snapshot` event. A manual Snapshot button is also always available.

### 4.6 Corrections
- **Undo last action** and **edit a time** (tap the time, adjust ±1 s / ±10 s, or set it directly).
- Corrections are append-only: `undo` and `edit` events reference the target `event_id`. Nothing is ever deleted.

### 4.7 End session
- **End session** asks for one confirmation (the only confirmation in the app), then logs `session_end`.
- It then shows:
  - Counts per event type.
  - Sync status.
  - The **Export CSV** button.

## 5. Event schema (one row per event, long format)
| Column | Type | Notes |
|---|---|---|
| event_id | UUID | Client-generated; dedupe key |
| session_id | UUID | |
| observer | text | |
| station | text | Deli, Butchery, Bakery, Checkout service, Checkout arrivals |
| device_id | UUID | Generated once per phone |
| event_type | text | session_start, session_end, arrival, service_start, service_end, balk, renege, interruption, join, lane_open, lane_close, snapshot, undo, edit |
| customer_seq | int | Per session; blank for non-customer events |
| lane | text | Checkout only |
| employee | text | E1/E2/E3… |
| order_type | text | S/W/P/M |
| items | int | |
| basket | text | H/B/T |
| pay | text | C/K |
| queue_len | text | Integer, or per-lane string such as "3/1/4/0" |
| employees_serving | int | Snapshot |
| employees_idle | int | Snapshot |
| registers_open | int | Snapshot |
| target_event_id | UUID | For undo/edit |
| new_timestamp | ISO | For edit |
| timestamp | ISO 8601 + ms | Device clock |
| elapsed_s | float | Since session_start |
| note | text | Optional free text |
| app_version | text | |

Order, items, basket and pay are attributes that can change after a card is created. Log each change as an `edit` event on the customer's `arrival` or `join` event.

## 6. Google Sheet + Apps Script
- **Sheet tabs:**
  - `events`: header row matches §5 exactly.
  - `sessions`: one row per `session_start`.
  - `employees`: session_id, code, description.
- **`doPost(e)`** must:
  1. Parse a JSON array of events.
  2. Check a shared token sent in the body.
  3. Take a `LockService` script lock.
  4. Read the existing `event_id` column and skip known ids.
  5. Append the new rows.
  6. Return `{stored: [ids]}`.
- **Deployment:** Execute as me; access Anyone. Karam deploys and authorizes it himself. The deploy URL and token go into the app's config file.
- The Sheet is shared with the whole team.

## 7. Analysis helper (Python, in the repo)
`pivot_events.py` reads the `events` CSV (exported from the Sheet), applies undo/edit events, and writes four files:
- `counter_customers.csv`: station, session, customer_seq, arrival, service_start, service_end, wait_s, service_s, employee, order_type, items, balk, renege, interruptions.
- `checkout_customers.csv`: the same shape for checkout, with lane, basket and pay.
- `arrivals_5min.csv`: counts per station/lane per 5-minute bin, plus raw interarrival times.
- `snapshots.csv`.

## 8. UX requirements
- Usable one-handed while standing. Tap targets ≥ 56 px; primary buttons ≥ 80 px tall.
- High contrast, readable in bright store lighting. Large time display.
- `touch-action: manipulation` (no double-tap zoom). No accidental navigation away.
- Keep the screen on with the Screen Wake Lock API where supported. Otherwise show a one-time tip: Settings → Display → Auto-Lock → Never.
- Never block a tap with a spinner or a network call.

## 8a. Visual design
The base is the teenage engineering style from Refero Styles: flat, industrial, monochrome. Its colours and shapes are kept. Its typography is replaced, because ultra-thin type is unreadable one-handed under store lighting.

**Keep from the base style**
- Light theme only:
  - Background `#f6f8f7`.
  - Text `#000000`.
  - Dark surface `#0f0e12` for the bottom action bar and the full-screen snapshot prompt.
  - Hairlines 1px `#e5e5e5`.
  - `#b2b2b2` only for disabled controls.
- 0px border radius everywhere. No shadows, no gradients.
- Content organised by 1px ruled bands, not filled boxes.
- Colour is rationed: only state gets colour, and each colour has exactly one meaning.

**Override (field use)**
- Use the system font stack (`-apple-system`, SF Pro). Do not load web fonts.
- Font sizes and weights:
  - Labels and buttons: weight 700. Never below weight 500.
  - Body text: ≥ 17px.
  - Customer number on a card: ≥ 28px, weight 800.
  - Clock and elapsed times: ≥ 32px with `font-variant-numeric: tabular-nums`, so digits don't jump.
- All text must reach contrast ≥ 7:1.

**State colours** (no other colours anywhere)
- Amber `#f5b800`: snapshot due. The full-screen prompt uses an amber band; it is the only alarm in the app.
- Black 4px border plus a "NEXT" tag: the card to time next, per the sampling hint.
- Sync dot:
  - Green `#1a7f37`: all synced.
  - Amber: pending.
  - Red `#d1242f`: offline or error.

**Layout**
- Status bar at top, 44px: `Saved · Synced · Pending`, plus the dot and the elapsed session time.
- Primary action in the bottom thumb zone: ARRIVAL, JOIN or the lane buttons.
  - Full width, ≥ 96px tall.
  - White text on `#0f0e12`.
- Open customer cards in one full-width column, divided by hairlines. Card buttons sit in one row, each ≥ 56px.
- Tap feedback: no haptics are available, so every tap inverts the button colours for 150 ms.

## 9. Non-goals
- No login.
- No customer personal data, photos or free-text descriptions of customers.
- No bagging fields.
- No ticket numbers.

## 10. Acceptance tests (dry run before 14:00 on 4 Nov)
1. **Airplane mode:** run a 10-minute session fully offline, then reconnect. Every event reaches the Sheet exactly once.
2. **Force-quit:** close the app mid-session and reopen. The session resumes with all events intact.
3. **Concurrency:** four phones log at the same time. No collisions or lost rows.
4. **Dry run:** four testers time each other for 10 minutes, one per mode. The counts in the Sheet match the counts on each phone.
5. **Export:** the CSV export opens in pandas, and `pivot_events.py` produces all four output files.

## 11. Build order
- **Session 1:**
  - Repo scaffold, IndexedDB store, setup screen, counter mode, snapshots, CSV export.
  - Deploy to GitHub Pages; Add to Home Screen on one iPhone; test offline.
  - At this point the app is usable without sync.
- **Session 2:**
  - Apps Script + sync queue.
  - Checkout service and arrivals modes, corrections, wake lock.
  - `pivot_events.py`; run the acceptance tests.
- **Fallback rule:** if sync fails the dry run, use the app offline and export CSV at session end. If the app fails, use paper.
