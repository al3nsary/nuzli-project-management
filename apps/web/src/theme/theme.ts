import {
  createTheme,
  defaultVariantColorsResolver,
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type VariantColorsResolver,
} from '@mantine/core';

/*
 * Mantine follows the Muhsen-aligned tokens (owner request A7, ADR-083). The colour names of
 * phases 1–4 are kept so screens did not have to change: `field` is now the Muhsen green,
 * `ok` = --live, `signal` = --amber, `breach` = --red; `gold` and `info` (--blue) are new.
 */

/** Muhsen green, centred on --g #14593F (index 6); --g3 #1D7452 at 5, --g2 #0C3A29 at 8. */
const field: MantineColorsTuple = [
  '#e4f2e9',
  '#c5e3d0',
  '#94c9a9',
  '#5fae82',
  '#2f8a5f',
  '#1d7452',
  '#14593f',
  '#104a34',
  '#0c3a29',
  '#072619',
];
/** --red #C0392B (light, index 6) and #EC4F54 (dark, index 4). */
const breach: MantineColorsTuple = [
  '#fbe9e7',
  '#f7cdc8',
  '#f09b93',
  '#ff8e91',
  '#ec4f54',
  '#d4443a',
  '#c0392b',
  '#a02f23',
  '#93261c',
  '#5e1610',
];
/** --live #0B8A4B (light) and #14C273 (dark). */
const ok: MantineColorsTuple = [
  '#e4f2e9',
  '#c2e6d0',
  '#8fd6ad',
  '#4fe49f',
  '#14c273',
  '#0f9f5c',
  '#0b8a4b',
  '#0b6540',
  '#084c30',
  '#053320',
];
/** --amber #B8791A (light) and #E5A62F (dark). */
const signal: MantineColorsTuple = [
  '#fbf1de',
  '#f6e0b8',
  '#f2c069',
  '#eab24a',
  '#e5a62f',
  '#cc8f22',
  '#b8791a',
  '#9a6514',
  '#7f5310',
  '#53360a',
];
/** Gold accent: --gold #A8875A, --gold2, --gold3. */
const gold: MantineColorsTuple = [
  '#f5eddf',
  '#ece0c8',
  '#e7d1a2',
  '#d6bb87',
  '#c6a86f',
  '#b4935f',
  '#a8875a',
  '#8a6c3c',
  '#6e5729',
  '#4a3a1b',
];
/** Info blue: --blue #1B6E9C (light) and #3FA3DC (dark). */
const info: MantineColorsTuple = [
  '#e7eef6',
  '#c7dcec',
  '#82c8ed',
  '#5fb6e6',
  '#3fa3dc',
  '#2788bf',
  '#1b6e9c',
  '#165a80',
  '#2a4a73',
  '#0c2f45',
];
/** Neutrals from --void to --ink (light). */
const slate: MantineColorsTuple = [
  '#eff1ed',
  '#e7f1ea',
  '#dde9e1',
  '#c6dace',
  '#9ab0a3',
  '#7a8f84',
  '#4c635a',
  '#2f4239',
  '#16261e',
  '#0d1a13',
];
/** Mantine dark ramp: [0] text … [4] borders, [6] cards/inputs, [7] body — Muhsen night. */
const dark: MantineColorsTuple = [
  '#edf5f0',
  '#c9d9d0',
  '#9fb6a9',
  '#6b857a',
  '#27473a',
  '#1c3128',
  '#14261f',
  '#0f1c16',
  '#0a140f',
  '#060c09',
];

const SHADOW =
  '0 1px 2px rgba(11,53,39,.05), 0 4px 10px -4px rgba(11,53,39,.07), 0 18px 34px -22px rgba(11,53,39,.3)';
const LIFT = '0 2px 6px rgba(11,53,39,.07), 0 18px 34px -14px rgba(11,53,39,.22)';

/** Light badges, alerts and theme icons use the Muhsen status pills (tokens follow the scheme). */
const PILL: Record<string, { b: string; t: string }> = {
  ok: { b: 'var(--p-live-b)', t: 'var(--p-live-t)' },
  green: { b: 'var(--p-live-b)', t: 'var(--p-live-t)' },
  signal: { b: 'var(--p-wait-b)', t: 'var(--p-wait-t)' },
  yellow: { b: 'var(--p-wait-b)', t: 'var(--p-wait-t)' },
  breach: { b: 'var(--p-no-b)', t: 'var(--p-no-t)' },
  red: { b: 'var(--p-no-b)', t: 'var(--p-no-t)' },
  info: { b: 'var(--p-blue-b)', t: 'var(--p-blue-t)' },
  blue: { b: 'var(--p-blue-b)', t: 'var(--p-blue-t)' },
  gold: { b: 'var(--p-gold-b)', t: 'var(--p-gold-t)' },
  slate: { b: 'var(--p-grey-b)', t: 'var(--p-grey-t)' },
  gray: { b: 'var(--p-grey-b)', t: 'var(--p-grey-t)' },
  field: { b: 'var(--sheen2)', t: 'var(--link)' },
};

const variantColorResolver: VariantColorsResolver = (input) => {
  const base = defaultVariantColorsResolver(input);
  const name = (input.color ?? input.theme.primaryColor).split('.')[0] ?? '';
  const pill = PILL[name];
  if (input.variant === 'light' && pill) {
    return { ...base, background: pill.b, hover: pill.b, color: pill.t, border: 'none' };
  }
  if (input.variant === 'subtle' && name === 'field') {
    return { ...base, color: 'var(--link)', hover: 'var(--sheen2)' };
  }
  return base;
};

export const theme = createTheme({
  primaryColor: 'field',
  primaryShade: { light: 6, dark: 6 },
  autoContrast: true,
  variantColorResolver,
  colors: {
    field,
    breach,
    ok,
    signal,
    gold,
    info,
    slate,
    red: breach,
    green: ok,
    yellow: signal,
    blue: info,
    gray: slate,
    dark,
  },
  white: '#ffffff',
  black: '#0d1a13',
  fontFamily: "'IBM Plex Sans Arabic', 'Segoe UI', system-ui, sans-serif",
  fontFamilyMonospace: "'IBM Plex Mono', ui-monospace, monospace",
  headings: {
    fontFamily: "'Readex Pro Variable', 'IBM Plex Sans Arabic', sans-serif",
    fontWeight: '600',
    sizes: {
      h1: { fontSize: '1.625rem', lineHeight: '1.3' },
      h2: { fontSize: '1.3rem', lineHeight: '1.35' },
      h3: { fontSize: '1.0625rem', lineHeight: '1.4' },
      h4: { fontSize: '0.9375rem', lineHeight: '1.4' },
    },
  },
  fontSizes: { xs: '0.75rem', sm: '0.875rem', md: '0.9375rem', lg: '1.0625rem', xl: '1.3rem' },
  lineHeights: { xs: '1.6', sm: '1.7', md: '1.75', lg: '1.6', xl: '1.5' },
  spacing: { xs: '8px', sm: '12px', md: '16px', lg: '24px', xl: '32px' },
  // --r4 chips, --r3 inputs and buttons, --r cards, --r2 dialogs.
  radius: { xs: '6px', sm: '9px', md: '12px', lg: '16px', xl: '22px' },
  defaultRadius: 'md',
  shadows: { xs: SHADOW, sm: SHADOW, md: SHADOW, lg: LIFT, xl: LIFT },
  focusRing: 'auto',
  respectReducedMotion: true,
  cursorType: 'pointer',
  components: {
    Card: { defaultProps: { radius: 'lg', withBorder: true, shadow: 'sm', padding: 'lg' } },
    Paper: { defaultProps: { radius: 'lg' } },
    Modal: { defaultProps: { radius: 'xl', centered: true, overlayProps: { backgroundOpacity: 1, color: 'var(--scrim)', blur: 6 } } },
    Drawer: { defaultProps: { overlayProps: { backgroundOpacity: 1, color: 'var(--scrim)', blur: 4 } } },
    Popover: { defaultProps: { radius: 'lg', shadow: 'lg' } },
    Menu: { defaultProps: { radius: 'lg', shadow: 'lg' } },
    Badge: { defaultProps: { radius: 'xl', variant: 'light' } },
    Tooltip: { defaultProps: { radius: 'sm', withArrow: true, openDelay: 250 } },
    Table: { defaultProps: { highlightOnHover: true, striped: false, verticalSpacing: 'sm' } },
    Button: { defaultProps: { radius: 'md' }, styles: { root: { minHeight: 42, fontWeight: 700 } } },
    TextInput: { defaultProps: { size: 'md' } },
    PasswordInput: { defaultProps: { size: 'md' } },
    Select: { defaultProps: { size: 'md' } },
    NumberInput: { defaultProps: { size: 'md' } },
    Textarea: { defaultProps: { size: 'md' } },
  },
});

/** Mantine surface/text variables follow the Nuzli tokens in both schemes. */
export const cssVariablesResolver: CSSVariablesResolver = () => {
  const common = {
    '--mantine-color-body': 'var(--panel)',
    '--mantine-color-text': 'var(--ink)',
    '--mantine-color-dimmed': 'var(--dim)',
    '--mantine-color-default-border': 'var(--line)',
    '--mantine-color-default': 'var(--panel)',
    '--mantine-color-default-hover': 'var(--panel2)',
    '--mantine-color-default-color': 'var(--ink)',
    '--mantine-color-placeholder': 'var(--dim2)',
    '--mantine-color-anchor': 'var(--link)',
    '--mantine-color-error': 'var(--red)',
  };
  return { variables: {}, light: common, dark: common };
};
