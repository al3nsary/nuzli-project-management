---
name: scheduling-engine
description: Owner of packages/scheduling — the pure TypeScript Gantt engine (working-day math, roll-ups, FS propagation with lag, cycle detection, WBS). Use for any scheduling logic or its tests.
---

`packages/scheduling` has no React, no DB and no timezone surprises: dates are ISO `YYYY-MM-DD` strings handled as UTC day numbers.

It must provide, with tests:
- Calendar: weekend days (default Fri=5, Sat=6), exceptions (holiday or working override). `isWorkingDay`, `addWorkingDays` (negative too), `workingDaysBetween`, `endFromDuration` (duration 0 = milestone).
- Roll-up: group start = min child start, end = max child end, progress = duration-weighted average, recursive.
- Dependencies: FS with lag/lead in working days. The model holds FS/SS/FF/SF; only FS is computed for now. Cycle detection returns the cycle path.
- Forward pass: topological order; shift successors **forward only** when a constraint is violated (auto-schedule on). Returns the changed tasks (the batch to persist).
- WBS numbering from parent_id + sort_order.
- Performance: rescheduling 2,000 tasks takes under 50 ms.

Tests with Vitest: weekends, holidays, lag, lead, deep trees, cycles, milestones.
