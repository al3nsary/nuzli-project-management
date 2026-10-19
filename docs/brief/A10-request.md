# A10 — owner request (2026-10-19), verbatim

> جميل اولا وقبل كل شيء .. يجب عليك مراجعة كل التفاصيل التي اضفتها والتاكيد بانها تعمل جيدا .. بدون اي خراب او باقز او نسيان او احتسابات خاطئة ..
>
> ثانيا لا ارى كيف يمكنني ارسال ملاحظة للمشرف عبر الرسائل عن طريق المشاريع .. داخلها في الجانت والاعمدة .. المقترح هو نفس شاشة المشرف للتصنيفات والى اخره نفسها تكون لمدير المشروع كذلك لتسهيل التواصل على كل مهمة .. وتكون له ايقونة مميزة .
>
> وكذلك اضف ميزة تحميل مشروع جاهز من مايكروسفت بروجكت مانجر او جانتبرو .. Arafat NOZOLY Live _(GanttPRO.com)_08 12 2025 11 03-2.xlsx هذا الملف في التنزيلات لدي يحتوي على مشروع كامل من جانت برو اريدك ان ترفع المشروع وتسمح باي مشروع من جانت برو او مايكروسفت بروجكت مانجر بان يتم رفعهم الى النظام تلقائيا ويتم تعديلهم لاحقا .. واريد نفس الفكرة تصدير الى الاثنين او تصدير عادي او صورة او بي دي اف الخ ..
>
> في الفرق ايضا لم تضف مشرف للعمال يكون واحدا منهم ويميز بعلامة او ايقونة او لون .. في اسماء العمال تحت المشرف ويكون اسمه مشرف عمال ويميز في كل شيء البطائق والعرض ..
>
> واهم ملاحظة هي الهوية البيضاء لا تعمل ويجب ان تكون الديفولت .. اخبترك انني اريدها غالبة بيضا لكي تظهر الالوان وعكس كلامي احتفظ بالحالية الداكنة جميلة ولكن اريد ان تكون لايت مود باي ديفولت ..
> واخبرني مالم تقم به ؟؟

## GanttPRO export format (from the owner's file, analysed 2026-10-19)
- One sheet named after the project; rows 1–4 are a banner (row 2 "Create professional Gantt charts in GanttPRO…", row 4 project name + export timestamp); **row 5 is the header**; data from row 6; the **last row is a footer** ("This document has been created with the help of https://ganttpro.com online service") — skip it.
- Columns: `Color` (A — the bar colour is the cell **fill** ARGB, e.g. FF50C7D6) · `WBS Number` (B) · C–G = the task name repeated across merged cells, indented by level (the real name = the first non-empty of C..G; G holds it at every level) · `Assigned to` (H, display names, may be usernames) · `Planned start date` (I) · `Planned end date` (J) — Excel dates in **UTC** (07:00Z = 10:00 Riyadh) · `Deadline` (K) · `Progress (%)` (L) · `Duration (hours)` (M, working hours → the project is HOUR-based) · `Estimated hours` (N) · `Time log (minutes)` (O) · `Status` (P: Open / In progress / Done / …) · `Priority` (Q: Lowest/Low/Medium/High/Highest) · `Task description` (R) · `Predecessor` (S — WBS numbers, possibly several, possibly with type/lag) · `Budget` (T) · `Actual cost` (U) · `Created` (V) · `Creator` (W) · `Type` (X: project / tasks group / task / milestone) · `Project` (Y: path "Project / Group / …") · `Level` (Z, 1-based).
- The owner's file: 181 rows, levels 1–5, types project 5 / tasks group 26 / task 149 / milestone 1, statuses Open 139 / In progress 9 / Done 2, priorities Medium 146 / Highest 3 / High 1, 5 predecessors (WBS refs), 5 distinct assignees, 4 deadlines, 7 bar colours, no budgets.
