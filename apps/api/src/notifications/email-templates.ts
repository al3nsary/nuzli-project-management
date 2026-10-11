import type { Role } from '@nuzli/shared';

/** Arabic, RTL, inline-styled e-mails (mail clients ignore external CSS). */

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'مدير النظام',
  SUPERVISOR: 'مشرف',
  MONITOR: 'مشرف مراقبة',
};

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Block {
  greeting: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  footnote?: string;
}

function layout(subject: string, block: Block): RenderedEmail {
  const paras = block.paragraphs
    .map((p) => `<p style="margin:0 0 14px;line-height:1.8">${escapeHtml(p)}</p>`)
    .join('');
  const button = block.action
    ? `<p style="margin:22px 0"><a href="${escapeHtml(block.action.url)}" style="background:#1D5C63;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;display:inline-block">${escapeHtml(block.action.label)}</a></p>
       <p style="margin:0 0 14px;font-size:13px;color:#5B6B73;direction:ltr;text-align:right;word-break:break-all">${escapeHtml(block.action.url)}</p>`
    : '';
  const foot = block.footnote
    ? `<p style="margin:18px 0 0;font-size:13px;color:#5B6B73">${escapeHtml(block.footnote)}</p>`
    : '';
  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#F4F6F5;font-family:'IBM Plex Sans Arabic',Tahoma,Arial,sans-serif;color:#14232B">
  <div dir="rtl" style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:12px;padding:28px;text-align:right">
    <h1 style="font-size:18px;margin:0 0 18px">نزلي — إدارة المشاريع والفرق الميدانية</h1>
    <p style="margin:0 0 14px">${escapeHtml(block.greeting)}</p>
    ${paras}${button}${foot}
    <hr style="border:none;border-top:1px solid #E3E8E6;margin:24px 0 12px">
    <p style="margin:0;font-size:12px;color:#8A979D">رسالة آلية، لا تردّ عليها.</p>
  </div>
</body>
</html>`;
  const text = [
    block.greeting,
    '',
    ...block.paragraphs,
    ...(block.action ? ['', `${block.action.label}: ${block.action.url}`] : []),
    ...(block.footnote ? ['', block.footnote] : []),
  ].join('\n');
  return { subject, html, text };
}

const hello = (name: string) => `مرحبًا ${name}،`;

export const emails = {
  registrationRequested(p: { adminName: string; applicantName: string; role: Role; url: string }) {
    return layout('طلب تسجيل جديد بانتظار المراجعة', {
      greeting: hello(p.adminName),
      paragraphs: [
        `قدّم ${p.applicantName} طلب تسجيل بصفة «${ROLE_LABELS[p.role]}».`,
        'راجع الطلب من صفحة «طلبات التسجيل» لاعتماده أو رفضه.',
      ],
      action: { label: 'فتح طلبات التسجيل', url: p.url },
    });
  },

  registrationApproved(p: { name: string; role: Role; url: string }) {
    return layout('اعتُمد حسابك في نزلي', {
      greeting: hello(p.name),
      paragraphs: [`اعتمد مدير النظام حسابك بصفة «${ROLE_LABELS[p.role]}».`, 'يمكنك الآن تسجيل الدخول.'],
      action: { label: 'تسجيل الدخول', url: p.url },
    });
  },

  registrationRejected(p: { name: string; reason: string }) {
    return layout('رُفض طلب تسجيلك في نزلي', {
      greeting: hello(p.name),
      paragraphs: ['نأسف لإبلاغك بأن طلب تسجيلك رُفض.', `السبب: ${p.reason}`],
      footnote: 'إن كان لديك استفسار فتواصل مع مدير النظام.',
    });
  },

  setPassword(p: { name: string; url: string; hours: number }) {
    return layout('أنشئ كلمة المرور لحسابك في نزلي', {
      greeting: hello(p.name),
      paragraphs: [
        'أنشأ مدير النظام حسابًا لك. اضغط الزر لاختيار كلمة المرور.',
        `الرابط صالح لمرة واحدة خلال ${p.hours} ساعة.`,
      ],
      action: { label: 'إنشاء كلمة المرور', url: p.url },
    });
  },

  resetPassword(p: { name: string; url: string; minutes: number }) {
    return layout('إعادة تعيين كلمة المرور', {
      greeting: hello(p.name),
      paragraphs: [
        'طُلبت إعادة تعيين كلمة المرور لحسابك.',
        `الرابط صالح لمرة واحدة خلال ${p.minutes} دقيقة.`,
      ],
      action: { label: 'تعيين كلمة مرور جديدة', url: p.url },
      footnote: 'إن لم تطلب ذلك فتجاهل هذه الرسالة؛ كلمة مرورك الحالية لم تتغيّر.',
    });
  },
};
