/**
 * Error codes with their Arabic messages. The API error shape is
 * `{ code, message_ar, details }` (brief §12); the web app shows `message_ar` as is.
 */
export const ERRORS = {
  VALIDATION_FAILED: 'البيانات المدخلة غير صحيحة. راجع الحقول المظلّلة.',
  UNAUTHENTICATED: 'انتهت جلستك. سجّل الدخول مرة أخرى.',
  FORBIDDEN: 'لا تملك صلاحية تنفيذ هذا الإجراء.',
  NOT_FOUND: 'العنصر المطلوب غير موجود أو حُذف.',
  CONFLICT_VERSION: 'عدّل مستخدمٌ آخر هذه البيانات قبلك. حدّث الصفحة لترى آخر نسخة.',
  RATE_LIMITED: 'محاولات كثيرة في وقت قصير. انتظر دقيقة ثم أعد المحاولة.',
  INTERNAL: 'حدث خطأ في الخادم. أعد المحاولة، وإن تكرّر فأبلغ مدير النظام.',

  // auth
  INVALID_CREDENTIALS: 'البريد أو الجوال أو كلمة المرور غير صحيحة.',
  ACCOUNT_PENDING: 'حسابك بانتظار اعتماد مدير النظام. ستصلك رسالة عند الاعتماد.',
  ACCOUNT_REJECTED: 'رُفض طلب تسجيلك. راجع الرسالة المرسلة إلى بريدك لمعرفة السبب.',
  ACCOUNT_SUSPENDED: 'حسابك موقوف. تواصل مع مدير النظام.',
  ACCOUNT_LOCKED: 'أُقفل الحساب مؤقتًا بعد محاولات دخول فاشلة. أعد المحاولة بعد ١٥ دقيقة.',
  PASSWORD_CHANGE_REQUIRED: 'غيّر كلمة المرور قبل المتابعة.',
  TOKEN_INVALID: 'الرابط غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.',
  CSRF_INVALID: 'تعذّر التحقّق من أمان الطلب. حدّث الصفحة ثم أعد المحاولة.',
  REFRESH_REUSED: 'استُخدمت جلستك من جهاز آخر، فأُنهيت كل الجلسات احتياطًا. سجّل الدخول من جديد.',

  // users
  EMAIL_TAKEN: 'هذا البريد مسجّل لحساب آخر.',
  MOBILE_TAKEN: 'رقم الجوال هذا مسجّل لحساب آخر.',
  NATIONAL_ID_TAKEN: 'رقم الهوية هذا مسجّل مسبقًا.',
  /** Shown to non-admins instead of NATIONAL_ID_TAKEN, so it never confirms that an ID exists (review L7). */
  NATIONAL_ID_NOT_ACCEPTED: 'تعذّر حفظ رقم الهوية هذا. تحقّق منه، وإن تكرّر فتواصل مع مدير النظام.',
  LAST_ADMIN: 'لا يمكن تنفيذ هذا الإجراء: هذا آخر مدير نظام نشط. أضف مديرًا آخر أولًا.',
  REJECTION_REASON_REQUIRED: 'اكتب سبب الرفض؛ سيُرسل إلى مقدّم الطلب.',
  INVALID_STATE: 'لا يمكن تنفيذ هذا الإجراء على الحساب في حالته الحالية.',
  NOT_PENDING: 'هذا الطلب لم يعد بانتظار المراجعة.',

  // teams
  COLOR_TAKEN: 'اختار مستخدمٌ آخر هذا اللون للتوّ. حدّثنا قائمة الألوان، فاختر لونًا آخر.',
  COLOR_INACTIVE: 'هذا اللون موقوف في لوحة الألوان.',
  NOT_A_SUPERVISOR: 'قائد الفريق يجب أن يكون مستخدمًا بصفة «مشرف».',
  MEMBER_ALREADY_IN_TEAM: 'العضو موجود في هذا الفريق أصلًا.',
  TEAM_NOT_ACTIVE: 'لا يمكن النقل إلى فريق غير نشط.',
  COLOR_EXISTS: 'هذا اللون موجود في اللوحة مسبقًا.',
  MULTIPLE_TEAMS_DISABLED: 'هذا المشرف يقود فريقًا آخر، والإعداد الحالي لا يسمح بأكثر من فريق.',

  NOT_PENDING_TEAM: 'هذا الفريق لم يعد بانتظار الاعتماد.',
  TEAM_ARCHIVED: 'هذا الفريق مؤرشف، فلا يمكن تعديله.',
  // A9 — several supervisors, worker foreman, organisational structure
  SUPERVISOR_ALREADY_IN_TEAM: 'هذا المشرف يقود الفريق أصلًا.',
  PRIMARY_SUPERVISOR_REQUIRED: 'هذا هو المشرف الرئيسي للفريق. اختر مشرفًا رئيسيًّا بديلًا قبل إزالته.',
  LAST_SUPERVISOR: 'لا يمكن إزالة آخر مشرف للفريق. أضف مشرفًا آخر أولًا.',
  FOREMAN_NOT_MEMBER: 'مشرف العمّال يجب أن يكون عضوًا حاليًّا في هذا الفريق.',
  FOREMAN_HAS_ACCOUNT: 'مشرف العمّال سجلّ عضو فقط، ولا يرتبط بحساب دخول في هذا الإصدار.',
  ORG_CYCLE: 'لا يمكن نقل الوحدة تحت نفسها أو تحت إحدى وحداتها الفرعية.',
  ORG_REPORTS_CYCLE: 'هذا الربط يجعل المنصب يتبع نفسه عبر سلسلة التبعية.',
  ORG_UNIT_NOT_EMPTY: 'الوحدة تحتوي على وحدات فرعية أو مناصب أو فرق مرتبطة. انقلها أو أزلها أولًا.',
  ORG_UNIT_ARCHIVED: 'هذه الوحدة مؤرشفة، فلا يمكن الإضافة إليها.',

  // reference data & cards
  NAME_TAKEN: 'هذا الاسم مستخدم مسبقًا. اختر اسمًا آخر.',
  BUILTIN_LOCKED: 'هذا العنصر مدمج في النظام ولا يمكن حذفه.',
  IN_USE: 'العنصر مستخدم في قوالب أو سجلات أخرى، فلا يمكن حذفه.',
  LOGO_FILE_INVALID: 'ملف الشعار غير صالح: ارفع صورة PNG أو JPEG أو WebP وأكّد رفعها أولًا.',
  PDF_NOT_CONFIGURED: 'تصدير PDF من الخادم غير مفعّل بعد. استخدم الطباعة من المتصفح.',
  PDF_FAILED: 'تعذّر إنشاء ملف PDF الآن. أعد المحاولة لاحقًا أو اطبع من المتصفح.',

  // tasks
  ASSIGNEE_NOT_SUPERVISOR: 'تُسند المهام إلى المشرفين فقط.',
  DEPENDENCY_CYCLE: 'هذا الربط يصنع حلقة بين المهام، فلا يمكن حفظه.',
  DEPENDENCY_SELF: 'لا يمكن ربط المهمة بنفسها.',
  DEPENDENCY_EXISTS: 'هذا الربط موجود مسبقًا.',
  DEPENDENCY_TYPE_DISABLED: 'هذا النوع من الربط غير مفعّل بعد؛ المتاح الآن «انتهاء ← بداية» فقط.',
  TASK_PARENT_INVALID: 'لا يمكن وضع المهمة تحت نفسها أو تحت إحدى مهامها الفرعية أو تحت معلَم.',
  PROJECT_ARCHIVED: 'هذا المشروع مؤرشف، فلا يمكن تعديله.',
  CALENDAR_DATE_EXISTS: 'يوجد استثناء في هذا التاريخ في التقويم مسبقًا.',
  /** Calculations audit H1: a group's status follows its sub-tasks. */
  TASK_GROUP_STATUS_DERIVED: 'حالة المجموعة تُحسب من مهامّها الفرعية، فلا تُعدَّل يدويًّا. غيّر حالة المهامّ داخلها.',
  // A9 — budget, labels, custom fields, view prefs, templates, time log
  LABEL_NOT_IN_PROJECT: 'الوسم لا يتبع هذا المشروع. حدّث الصفحة واختر وسمًا من المشروع نفسه.',
  CUSTOM_FIELD_VALUE_INVALID: 'القيمة لا تناسب نوع الحقل المخصّص.',
  CUSTOM_FIELD_OPTIONS_REQUIRED: 'أضف خيارًا واحدًا على الأقل لحقل القائمة المنسدلة.',
  VIEW_PREF_TOO_LARGE: 'الإعداد المحفوظ أكبر من المسموح (٣٢ كيلوبايت).',
  VIEW_PREF_LIMIT: 'وصلت إلى الحدّ الأعلى للإعدادات المحفوظة (٢٠٠). احذف بعض طرق العرض المحفوظة ثم أعد المحاولة.',
  NOT_A_TEMPLATE: 'هذا المشروع ليس قالبًا.',
  TIME_ENTRY_NOT_ALLOWED: 'تسجّل الوقت على المهام المسندة إليك فقط.',
  COMMENT_REPLY_INVALID: 'التعليق المقتبس ليس في هذه المهمة.',

  // A9 imports, exports, hours (ADR-109..112)
  IMPORT_FILE_INVALID: 'تعذّرت قراءة الملف. تأكّد أنّه بالصيغة المختارة وغير تالف، ثم أعد رفعه.',
  IMPORT_FORMAT_MISMATCH: 'محتوى الملف لا يطابق الصيغة المختارة.',
  IMPORT_NO_TASKS: 'لم نجد مهامّ في الملف. تأكّد من وجود عمود «اسم المهمة» وصفوف تحته.',
  IMPORT_TOO_MANY_TASKS: 'الملف فيه مهامّ أكثر من الحدّ المسموح (٥٬٠٠٠ مهمة). قسّمه إلى أكثر من مشروع.',
  IMPORT_PREVIEW_EXPIRED: 'انتهت صلاحية المعاينة (ساعة واحدة) أو اعتُمدت من قبل. أعد رفع الملف.',
  MPP_CONVERTER_NOT_CONFIGURED:
    'تحويل ملفات ‎.mpp غير مفعّل على هذا الخادم. افتح الملف في MS Project واختر «ملف ← حفظ باسم ← XML»، ثم استورد ملف XML.',
  MPP_CONVERSION_FAILED: 'تعذّر تحويل ملف ‎.mpp. احفظه من MS Project بصيغة XML ثم استورده.',
  JIRA_URL_NOT_ALLOWED: 'رابط Jira غير مسموح. استخدم رابط https الخاص بموقعك على atlassian.net، أو اطلب من مدير النظام إضافة الخادم إلى القائمة المسموحة.',
  JIRA_AUTH_FAILED: 'رفض Jira الدخول. تحقّق من البريد ورمز الـ API ومن صلاحيتك على المشروع.',
  JIRA_REQUEST_FAILED: 'تعذّر الاتصال بـ Jira الآن. تحقّق من الرابط والاستعلام ثم أعد المحاولة.',

  // violations
  LOCATION_REQUIRED: 'الموقع الجغرافي مطلوب لتسجيل المخالفة.',
  ID_PHOTO_REQUIRED: 'صورة بطاقة الهوية مطلوبة.',
  EVIDENCE_REQUIRED: 'أرفق صورة واحدة للمخالفة على الأقل.',
  TOO_MANY_PHOTOS: 'تجاوزت الحد الأعلى لعدد صور المخالفة.',
  EDIT_WINDOW_CLOSED: 'انتهت مهلة تعديل هذه المخالفة. يعدّلها مدير النظام فقط.',
  CANCEL_REASON_REQUIRED: 'اكتب سبب الإلغاء.',
  MEMBER_HAS_NO_TEAM: 'العضو لم يكن ضمن أي فريق في وقت المخالفة.',
  PERSON_PHOTO_REQUIRED: 'صورة الشخص مطلوبة.',
  VIOLATION_ALREADY_ASSIGNED: 'هذه المخالفة مسندة إلى شخص مسبقًا. ألغِ الإسناد أولًا.',
  VIOLATION_TOO_OLD_TO_REGISTER:
    'تاريخ التقاط المخالفة خارج المدة المسموحة لتسجيل عضو منها في فريق (أقدم من الحدّ المضبوط في الإعدادات، أو في المستقبل). سجّل العضو من صفحة الفريق، ثم أسند المخالفة إليه.',

  // files
  FILE_TYPE_NOT_ALLOWED: 'نوع الملف غير مسموح. ارفع صورة JPEG أو PNG أو WebP أو ملف PDF.',
  FILE_TOO_LARGE: 'حجم الملف أكبر من المسموح.',
  FILE_NOT_UPLOADED: 'لم يكتمل رفع الملف. أعد المحاولة.',
} as const;

export type ErrorCode = keyof typeof ERRORS;

export interface ApiErrorBody {
  code: ErrorCode;
  message_ar: string;
  details?: unknown;
}

export function errorBody(code: ErrorCode, details?: unknown): ApiErrorBody {
  return { code, message_ar: ERRORS[code], ...(details === undefined ? {} : { details }) };
}
