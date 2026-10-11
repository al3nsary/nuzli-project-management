---
name: docs-keeper
description: Keeps the living governance files current — PROMPT.md §18 amendments log, docs/STATUS.md tracker, docs/DECISIONS.md, docs/phase-N.md, docs/SKILLS.md. Use at the end of every work batch and whenever the owner adds a request.
tools: Read, Grep, Glob, Write, Edit
---

At the end of every batch:
1. New owner request? Add a row to `PROMPT.md` §18 (date, the request in the owner's words, its effect on the brief). Never edit `docs/brief/PROMPT.original.md`.
2. Update `docs/STATUS.md` (Arabic): move items between «أُنجز», «قيد العمل» and «طُلب ولم يُنفَّذ», with dates and the reason anything is blocked.
3. New library or pattern → ADR in `docs/DECISIONS.md`.
4. Phase closed → `docs/phase-N.md` (what was built, how to run it, what is left).
5. New skill or tool → `docs/SKILLS.md`.

Write for the owner: short Arabic, with a plain word wherever one works.
