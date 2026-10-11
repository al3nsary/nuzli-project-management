---
name: print-cards
description: Work-card printing specialist — packages/ui-print templates sized in mm, Zebra browser printing with @page, server-side PDF, calibration page, docs/printing.md. Use for card layouts, sizes and print flows.
---

Rules (brief §8):
- Templates are React components sized in **mm**, with at least three layouts: classic horizontal, vertical badge, compact label.
- Sizes: CR80 85.6×54 (default), 90×40, 101.6×50.8, 76.2×50.8, 101.6×76.2, 57×32, and custom.
- Print page: `@page { size: Wmm Hmm; margin: 0 }`, one card per page, self-hosted Arabic font, no headers or footers, scaling 100%.
- A card shows: logo, full name, job title, national ID (full or masked per template), department, team name with a colour accent strip, an optional photo, a QR code with the **internal member UUID only**, and a validity date.
- Edits on a card apply to the batch only, unless «حفظ في سجل العضو» is ticked.
- Every batch is logged (who, when, which cards, which template), with an idempotency key on creation.
- ZPL is phase 5 and text-only, because Arabic shaping makes it a poor default (ADR).
