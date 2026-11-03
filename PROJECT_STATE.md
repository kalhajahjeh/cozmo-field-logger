# PROJECT_STATE — Simply Cozmo Dabouq 1 Simulation
Last updated: 2026-11-04

## Locked decisions
| # | Decision | Detail | Date |
|---|----------|--------|------|
| 1 | Model structure | Independent stations: each counter and checkout gets its own observed arrival stream (Source + Rate Table). No shopping time, no store-level routing. | 2026-11-04 |
| 2 | Problem framing | Staffing–demand mismatch: fixed shift staffing vs. arrivals that vary by hour and day, giving queues at peak and idle staff off-peak. Requires both peak and off-peak observations. | 2026-11-04 |
| 3 | Terminology | "Employee", not "clerk". Employees at a counter are labelled E1, E2, E3 per session. | 2026-11-04 |
| 4 | Not recorded | Bagging; ticket numbers (no ticket machines at this store); entry/exit time in store. | 2026-11-04 |
| 5 | Data tooling | iPhone web app (Home Screen) syncing to a Google Sheet; paper sheets always carried as backup. Spec: APP_SPEC.md. | 2026-11-04 |
| 6 | Field definitions | As in the "Cozmo Field Data Sheets" doc (event definitions, codes, sampling rule). | 2026-11-04 |

## Open decisions
| # | Decision | Options | Decide by |
|---|----------|---------|-----------|
| 1 | Bakery in scope? | Include if counter-served and busy / snapshots only / drop | 4 Nov debrief |
| 2 | Off-peak session | Date and window (e.g., Friday morning) | 4 Nov debrief |
| 3 | Rate Table interval | 15 min / 30 min (depends on arrival counts per interval) | After session 1 |
| 4 | Study window in the model | Observed peak window only / peak + off-peak as separate runs | After session 1 |
| 5 | To-Be scenarios | Cross-training, shift rescheduling, grab-and-go pre-packed, etc. | Phase 3 |

## Field access
- Permission status: not yet; asking on site 4 Nov with official GJU letter
- Contact at store:
- Restrictions (no photos, where we can stand, etc.):
- Data requested from manager: hourly POS transaction counts (3–4 weeks), staff schedule per department

## Sessions
| # | Date | Day | Window | Type | Stations | Status |
|---|------|-----|--------|------|----------|--------|
| 1 | 2026-11-04 | Wed | 17:00–19:00 (observe 17:30–18:45) | Peak | Deli, Butchery, Checkout service, Checkout arrivals | Planned |
| 2 | | | | Off-peak | | Not scheduled |

## Station assignments (session 1)
| Station | Observer | Records |
|---------|----------|---------|
| Deli | | Counter events, snapshots (+ bakery snapshots if counter-served) |
| Butchery | | Counter events, snapshots |
| Checkout service | | Checkout events on 2 adjacent open lanes |
| Checkout arrivals | | Queue joins per lane, checkout snapshots |

## Data collection log
| Date | Station | Variable | Observer | n | File |
|------|---------|----------|----------|---|------|

## Fitted input distributions
| Variable | Station | Period | n | Distribution | Parameters | K-S p | A-D p | Notes |
|----------|---------|--------|---|--------------|------------|-------|-------|-------|

## Assumptions (not collected — must be justified in report)
| Assumption | Value | Source / justification |
|------------|-------|------------------------|

## Validation data (kept separate from input data)
| Date | Measure | n | Mean | SD | File |
|------|---------|---|------|----|------|

## Report section status
| # | Section | Phase | Status | Owner |
|---|---------|-------|--------|-------|
| 3 | Introduction | 1 | not started | |
| 4 | Literature Review | 1 | not started | |
| 5 | Problem Formulation & Objectives | 1 | not started | |
| 6 | Model Conceptualization | 1 | not started | |
| 7 | Input Analysis | 1 | not started | |

## References (verified only)
1.

## Risks
| Risk | Effect | Mitigation |
|------|--------|------------|
| Permission refused or deferred to head office | Session 1 cannot run | Ask early on 4 Nov; ask who approves and how fast |
| App not ready or untested by session time | Data loss or wasted session | Paper sheets always carried; app used only if it passes a dry run |
| Only 1–2 sessions | Arrival profile from a single day | Request POS hourly data; state as limitation |
| Off-peak n < 30 | Weak service-time fits | Pool across periods if a two-sample test allows |
| n = 30–50 | K-S/A-D low power | Q-Q plots; state as limitation |
