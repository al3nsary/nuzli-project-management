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

  // violations
  LOCATION_REQUIRED: 'الموقع الجغرافي مطلوب لتسجيل المخالفة.',
  ID_PHOTO_REQUIRED: 'صورة بطاقة الهوية مطلوبة.',
  EVIDENCE_REQUIRED: 'أرفق صورة واحدة للمخالفة على الأقل.',
  TOO_MANY_PHOTOS: 'تجاوزت الحد الأعلى لعدد صور المخالفة.',
  EDIT_WINDOW_CLOSED: 'انتهت مهلة تعديل هذه المخالفة. يعدّلها مدير النظام فقط.',
  CANCEL_REASON_REQUIRED: 'اكتب سبب الإلغاء.',
  MEMBER_HAS_NO_TEAM: 'العضو لم يكن ضمن أي فريق في وقت المخالفة.',

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
