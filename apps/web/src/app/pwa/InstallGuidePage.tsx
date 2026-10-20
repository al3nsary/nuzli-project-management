import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@mantine/core';
import { IconBrandAndroid, IconCircleCheck, IconInfoTriangle, IconRefresh, IconSquarePlus, IconUpload } from '@tabler/icons-react';
import { NozolyLogo } from '../../components/Brand';
import { t } from '../../i18n';
import { promptInstall, useInstallMode, useInstallStore } from './install';

/**
 * The iPhone illustration in the identity (inline SVG, violet strokes on white, theme-aware):
 * Safari's toolbar with the Share button, then the share sheet with «إضافة إلى الشاشة الرئيسية».
 */
function Illustration() {
  return (
    <svg className="nz-ig-art" viewBox="0 0 320 236" role="img" aria-label={t('install.guide.illustration')}>
      {/* Phone 1: Safari with the share button */}
      <g transform="translate(176 8)">
        <rect x="0" y="0" width="128" height="220" rx="22" className="ig-phone" />
        <rect x="10" y="22" width="108" height="14" rx="7" className="ig-fill" />
        <rect x="16" y="50" width="96" height="10" rx="5" className="ig-fill" />
        <rect x="16" y="68" width="70" height="10" rx="5" className="ig-fill" />
        <rect x="16" y="94" width="96" height="58" rx="10" className="ig-card" />
        <path d="M0 176h128v22a22 22 0 0 1-22 22H22A22 22 0 0 1 0 198z" className="ig-bar" />
        <circle cx="64" cy="194" r="14" className="ig-hl" />
        <path d="M64 186v12m-5-7 5-5 5 5M58 194v6h12v-6" className="ig-icon-on" />
        <path d="M22 189l-5 5 5 5M106 189l5 5-5 5" className="ig-icon" />
        <text x="64" y="171" className="ig-label" textAnchor="middle">
          {t('install.guide.shareLabel')}
        </text>
        <circle cx="114" cy="12" r="11" className="ig-step" />
        <text x="114" y="16" className="ig-step-n" textAnchor="middle">
          1
        </text>
      </g>
      {/* arrow (logical: from the first phone to the second; drawn right-to-left) */}
      <path d="M168 118h-20m6-6-6 6 6 6" className="ig-arrow" />
      {/* Phone 2: the share sheet */}
      <g transform="translate(16 8)">
        <rect x="0" y="0" width="128" height="220" rx="22" className="ig-phone" />
        <rect x="0" y="70" width="128" height="150" rx="18" className="ig-sheet" />
        <rect x="12" y="84" width="104" height="22" rx="7" className="ig-fill" />
        <rect x="8" y="118" width="112" height="30" rx="8" className="ig-hl-row" />
        <rect x="94" y="124" width="18" height="18" rx="5" className="ig-icon-box" />
        <path d="M103 128v10m-5-5h10" className="ig-icon-on2" />
        <text x="50" y="136.5" className="ig-label strong" textAnchor="middle">
          {t('install.guide.addLabel')}
        </text>
        <rect x="12" y="158" width="104" height="18" rx="6" className="ig-fill" />
        <rect x="12" y="184" width="104" height="18" rx="6" className="ig-fill" />
        <circle cx="114" cy="12" r="11" className="ig-step" />
        <text x="114" y="16" className="ig-step-n" textAnchor="middle">
          2
        </text>
      </g>
    </svg>
  );
}

/**
 * «أضف إلى الشاشة الرئيسية» (A12): the iPhone/iPad install guide — three clear steps with an
 * illustration in our style, a note for other iOS browsers, how updates arrive, and the Android
 * path. A public page (it works before signing in too). Installed already → says so.
 */
export function InstallGuidePage() {
  const mode = useInstallMode();
  const platform = useInstallStore((s) => s.platform);
  const iosSafari = useInstallStore((s) => s.iosSafari);
  useEffect(() => {
    document.title = `${t('install.guide.title')} · ${t('app.name')}`;
  }, []);
  const steps = [
    { icon: IconUpload, title: t('install.guide.step1'), body: t('install.guide.step1Body') },
    { icon: IconSquarePlus, title: t('install.guide.step2'), body: t('install.guide.step2Body') },
    { icon: IconCircleCheck, title: t('install.guide.step3'), body: t('install.guide.step3Body') },
  ];
  return (
    <main className="nz-ig" id="main">
      <div className="nz-ig-card">
        <div className="nz-ig-logo">
          <NozolyLogo width={132} />
        </div>
        <h1 className="nz-ig-title" tabIndex={-1}>
          {t('install.guide.title')}
        </h1>
        <p className="nz-ig-lead">{t('install.guide.lead')}</p>

        {mode === 'installed' ? (
          <p className="nz-ig-done" role="status">
            <IconCircleCheck size={20} aria-hidden /> {t('install.guide.done')}
          </p>
        ) : null}

        {platform === 'ios' && !iosSafari ? (
          <p className="nz-ig-warn" role="note">
            <IconInfoTriangle size={18} aria-hidden /> {t('install.guide.notSafari')}
          </p>
        ) : null}

        <Illustration />

        <ol className="nz-ig-steps">
          {steps.map((s, i) => (
            <li key={i}>
              <span className="nz-ig-n" aria-hidden>
                {i + 1}
              </span>
              <span className="nz-ig-step">
                <b>
                  <s.icon size={18} stroke={1.8} aria-hidden /> {s.title}
                </b>
                <span>{s.body}</span>
              </span>
            </li>
          ))}
        </ol>

        <div className="nz-ig-note">
          <IconRefresh size={18} aria-hidden />
          <span>
            <b>{t('install.guide.updatesTitle')}</b>
            {t('install.guide.updates')}
          </span>
        </div>

        <div className="nz-ig-note">
          <IconBrandAndroid size={18} aria-hidden />
          <span>
            <b>{t('install.guide.android')}</b>
            {t('install.guide.androidBody')}
          </span>
        </div>

        <div className="nz-ig-actions">
          {mode === 'prompt' ? (
            <Button size="md" onClick={() => void promptInstall()} fullWidth>
              {t('install.button')}
            </Button>
          ) : null}
          <Button component={Link} to="/" variant={mode === 'prompt' ? 'default' : 'filled'} size="md" fullWidth>
            {t('install.guide.back')}
          </Button>
        </div>
      </div>
    </main>
  );
}
