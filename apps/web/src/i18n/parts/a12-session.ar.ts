/**
 * A12 strings shared by every screen (owner request 2026-10-20): workspaces (أقسام), the session,
 * the roles, the «صلاحية مزدوجة» badge, audit actions and notification types of A12.
 * Spread into ar.ts; en.ts mirrors the keys (a12-session.en.ts).
 */
export const arA12Session = {
  // ---- roles (A12): workspace roles and the account layer
  'role.ASSISTANT': 'مساعد',
  'role.MEMBER': 'عضو',
  'role.OWNER': 'مالك',
  'accountRole.OWNER': 'مالك النظام',
  'accountRole.USER': 'مستخدم',
  'participantLevel.EDITOR': 'محرّر',
  'participantLevel.CONTRIBUTOR': 'مساهم',
  'participantLevel.VIEWER': 'مطّلع',
  'participantLevel.EDITOR.hint': 'يعدّل مهام المشروع وينشئها ويحذفها، دون إعدادات المشروع وميزانيته.',
  'participantLevel.CONTRIBUTOR.hint': 'يرى المهام ويغيّر حالتها ونسبة إنجازها ويكتب الملاحظات والردود، كالمشرف.',
  'participantLevel.VIEWER.hint': 'يطّلع على المشروع ومهامه دون أي تعديل أو تعليق.',

  // ---- navigation (A12)
  'navGroup.system': 'إدارة النظام',
  'nav.systemWorkspaces': 'الأقسام',
  'nav.systemOwners': 'الملّاك',
  'nav.systemAccounts': 'كل الحسابات',
  'nav.requests': 'الطلبات',
  'nav.workerRequests': 'طلبات العمّال',

  // ---- the workspace name under the logo
  'workspace.label': 'القسم',
  'workspace.current': 'القسم الحالي: {name}',
  'workspace.none': 'لم يُختر قسم بعد',

  // ---- «اختر القسم» (after sign-in, several workspaces)
  'workspacePick.docTitle': 'اختر القسم',
  'workspacePick.title': 'اختر القسم',
  'workspacePick.sub': 'لك صلاحيات في أكثر من قسم. اختر القسم الذي تعمل فيه الآن، ويمكنك التبديل لاحقًا من قائمة اسمك في الشريط العلوي.',
  'workspacePick.enter': 'الدخول إلى {name}',
  'workspacePick.ownerAll': 'مالك النظام — كل الصلاحيات',
  'workspacePick.entering': 'جارٍ الدخول إلى القسم…',
  'workspacePick.signOut': 'تسجيل الخروج',
  'workspacePick.empty': 'لا يوجد قسم متاح لك الآن. تواصل مع مدير النظام.',
  'workspacePick.lost': 'لم يعد القسم السابق متاحًا لك. اختر قسمًا آخر.',

  // ---- the switcher (top-bar user menu)
  'workspaceSwitch.section': 'الأقسام',
  'workspaceSwitch.active': 'القسم الحالي',
  'workspaceSwitch.to': 'التبديل إلى {name}',
  'workspaceSwitch.done': 'انتقلت إلى قسم «{name}».',
  'workspaceSwitch.failed': 'تعذّر التبديل إلى هذا القسم.',
  // A12 security review H3: unsynced violations are kept per workspace, never wiped on a switch.
  'workspaceSwitch.keptElsewhere': 'على هذا الجهاز {n} مخالفة لم تُرسل بعد من قسم «{name}». لم تُحذف: تُرسل تلقائيًّا حين تعود إلى ذلك القسم.',
  'workspaceSwitch.keptElsewhere.one': 'على هذا الجهاز مخالفة واحدة لم تُرسل بعد من قسم «{name}». لم تُحذف: تُرسل تلقائيًّا حين تعود إلى ذلك القسم.',
  'workspaceSwitch.keptElsewhere.two': 'على هذا الجهاز مخالفتان لم تُرسلا بعد من قسم «{name}». لم تُحذفا: تُرسلان تلقائيًّا حين تعود إلى ذلك القسم.',
  'workspaceSwitch.keptElsewhere.few': 'على هذا الجهاز {n} مخالفات لم تُرسل بعد من قسم «{name}». لم تُحذف: تُرسل تلقائيًّا حين تعود إلى ذلك القسم.',
  'workspaceSwitch.keptElsewhere.many': 'على هذا الجهاز {n} مخالفة لم تُرسل بعد من قسم «{name}». لم تُحذف: تُرسل تلقائيًّا حين تعود إلى ذلك القسم.',
  'workspacePick.unsynced': '{n} مخالفة لم تُرسل',
  'workspacePick.unsynced.one': 'مخالفة واحدة لم تُرسل',
  'workspacePick.unsynced.two': 'مخالفتان لم تُرسلا',
  'workspacePick.unsynced.few': '{n} مخالفات لم تُرسل',
  'workspacePick.unsynced.many': '{n} مخالفة لم تُرسل',
  'workspacePick.unsyncedNotice': 'على هذا الجهاز مخالفات سجّلتها ولم تصل إلى الخادم بعد. هي محفوظة ولن تُحذف: ادخل القسم الذي سُجّلت فيه (المعلَّم أدناه) لتُرسل تلقائيًّا.',
  'outbox.elsewhere': 'على هذا الجهاز {n} مخالفة لم تُرسل من قسم «{name}»؛ محفوظة وتُرسل حين تدخل ذلك القسم.',
  'outbox.elsewhere.one': 'على هذا الجهاز مخالفة واحدة لم تُرسل من قسم «{name}»؛ محفوظة وتُرسل حين تدخل ذلك القسم.',
  'outbox.elsewhere.two': 'على هذا الجهاز مخالفتان لم تُرسلا من قسم «{name}»؛ محفوظتان وتُرسلان حين تدخل ذلك القسم.',
  'outbox.elsewhere.few': 'على هذا الجهاز {n} مخالفات لم تُرسل من قسم «{name}»؛ محفوظة وتُرسل حين تدخل ذلك القسم.',
  'outbox.elsewhere.many': 'على هذا الجهاز {n} مخالفة لم تُرسل من قسم «{name}»؛ محفوظة وتُرسل حين تدخل ذلك القسم.',
  'sync.err.workspace': 'الجلسة ليست في قسم هذه المخالفة الآن. تُرسل حين تدخل قسمها.',
  'workspaceSwitch.clears': 'يمسح التبديل ما يخصّ القسم الحالي من هذا الجهاز (القوائم المحفوظة والطباعة المفتوحة). المخالفات التي لم تُرسل تبقى محفوظة وتُرسل حين تعود إلى قسمها.',

  // ---- «صلاحية مزدوجة»
  'dualRole.badge': 'صلاحية مزدوجة',
  'dualRole.tooltip': 'لهذا الشخص أكثر من صفة: {roles}',
  'dualRole.tooltipHidden': 'لهذا الشخص صفة أخرى في قسم آخر.',
  'dualRole.nameWithBadge': '{name} — صلاحية مزدوجة',
  'dualRole.tooltipShort': 'لهذا الشخص أكثر من صفة في النظام، فصلاحياته تجمع الصفتين.',
  'dualRole.otherWorkspace': 'صفة في قسم آخر',
  'dualRole.dialogTitle': 'منح صلاحية ثانية لنفس الشخص',
  'dualRole.dialogBody': 'لهذا الشخص صفة أخرى في النظام. منحه هذه الصفة أيضًا يجعله صاحب «صلاحية مزدوجة»: يجمع صلاحيات الصفتين معًا، وتظهر بجانب اسمه علامة «صلاحية مزدوجة» في كل مكان.',
  'dualRole.currentRoles': 'صفاته الحالية:',
  'dualRole.confirm': 'تأكيد المنح بصلاحية مزدوجة',
  'dualRole.cancel': 'إلغاء المنح',

  // ---- audit actions (A12 round 1 + 2)
  'audit.action.auth.workspace_switched': 'التبديل إلى قسم',
  'audit.action.user.owner_promoted': 'ترقية حساب إلى مالك',
  'audit.action.owner.cross_workspace_access': 'دخول مالك عبر الأقسام',
  'audit.action.owner.added': 'إضافة مالك',
  'audit.action.owner.removed': 'إزالة مالك',
  'audit.action.workspace.created': 'إنشاء قسم',
  'audit.action.workspace.renamed': 'تغيير اسم قسم',
  'audit.action.workspace.archived': 'أرشفة قسم',
  'audit.action.workspace.restored': 'استعادة قسم',
  'audit.action.membership.added': 'منح صفة في القسم',
  'audit.action.membership.updated': 'تعديل صفة في القسم',
  'audit.action.membership.removed': 'سحب صفة من القسم',
  'audit.action.user.updated': 'تعديل بيانات مستخدم',
  'audit.action.user.username_changed': 'تغيير اسم المستخدم',
  'audit.action.user.password_set': 'تعيين كلمة مرور جديدة لمستخدم',
  'audit.action.project.participant_added': 'إضافة مشارك إلى مشروع',
  'audit.action.project.participant_updated': 'تعديل مشارك في مشروع',
  'audit.action.project.participant_removed': 'إزالة مشارك من مشروع',
  'audit.action.member_request.created': 'طلب إضافة أو إزالة عامل',
  'audit.action.member_request.approved': 'اعتماد طلب عامل',
  'audit.action.member_request.rejected': 'رفض طلب عامل',
  'audit.action.member.archived': 'إزالة عامل',
  'audit.action.project.cover_updated': 'تغيير صورة غلاف مشروع',
  'audit.action.project.cover_removed': 'إزالة صورة غلاف مشروع',

  // ---- notification types (A12 round 2)
  'notif.type.MEMBER_REQUEST_CREATED': 'طلب من {by} على عامل في «{team}»: {request}.',
  'notif.type.MEMBER_REQUEST_DECIDED': 'طلبك بشأن العامل {name}: {decision}.',
  'notif.type.PROJECT_PARTICIPANT_ADDED': 'أُضفت إلى مشروع «{project}» بصفة {level}.',
  'notif.request.ADD': 'إضافة {name}',
  'notif.request.REMOVE': 'إزالة {name}',
  'notif.decision.APPROVED': 'اعتُمد',
  'notif.decision.REJECTED': 'رُفض',

  // ---- login (A12: username)
  'login.demoKind.OWNER': 'المالك',
  'login.demoKind.ADMIN': 'مدير النظام',
  'login.demoKind.SUPERVISOR': 'مشرف',
  'login.demoKind.MONITOR': 'مشرف مراقبة',
  'login.demoKind.ASSISTANT': 'مساعد',
  'login.demoKind.EDITOR': 'مشارك محرّر',
  'login.demoKind.VIEWER': 'مشارك مطّلع',
  'login.demoAsKind': 'الدخول بحساب {kind} التجريبي',
  'login.demoUsername': 'اسم المستخدم: {username}',
  'login.demoOwnerHint': 'حساب مالك النظام: اسم المستخدم {username} وكلمة المرور نفسها.',

  // ---- the home of an assistant or a project participant
  'grantsHome.projects': 'مشاريعي المشارك فيها',
  'grantsHome.pages': 'ما يمكنك فتحه',
  'grantsHome.emptyTitle': 'لا صلاحيات بعد',
  'grantsHome.emptyBody': 'لم تُمنح لك صلاحيات في هذا القسم بعد. تواصل مع مدير النظام.',

  // ---- registration (A12): the workspace step
  'register.workspace': 'القسم',
  'register.workspacePlaceholder': 'اختر القسم الذي تتقدّم إليه',
  'register.workspaceHint': 'يصل طلبك إلى مديري هذا القسم.',
  'register.username': 'اسم المستخدم (اختياري)',
  'register.usernameHint': 'حروف لاتينية صغيرة وأرقام، ويبدأ بحرف. إن تركته فارغًا أُنشئ من بريدك.',
} as const;
