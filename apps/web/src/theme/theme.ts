import {
  createTheme,
  defaultVariantColorsResolver,
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type VariantColorsResolver,
} from '@mantine/core';

/*
 * Mantine follows the Nozoly identity (owner request A9): white surfaces, Nozoly indigo as the
 * primary colour. The colour names of phases 1–4 are kept so screens did not have to change:
 * `field` is now Nozoly indigo, `ok` = --live, `signal` = --amber, `breach` = --red,
 * `info` = --blue; `gold` (the Muhsen-era accent) now resolves to indigo as well.
 */

/** Nozoly indigo: #303F9F at 6 (light primary), #3F51B5 at 5 (dark primary, white text 6.9:1). */
const field: MantineColorsTuple = [
  '#e8eaf6',
  '#c5cae9',
  '#9fa8da',
  '#7986cb',
  '#5c6bc0',
  '#3f51b5',
  '#303f9f',
  '#283593',
  '#1a237e',
  '#121858',
];
/** --red #C62828 (light, index 6) and #EF6461 (dark, index 4). */
const breach: MantineColorsTuple = [
  '#fdecea',
  '#f9cfcc',
  '#f3a29e',
  '#ef9a9a',
  '#ef6461',
  '#d93a36',
  '#c62828',
  '#b3261e',
  '#8e1c16',
  '#5c120e',
];
/** --live #2E7D32 (light) and #81C784 (dark). */
const ok: MantineColorsTuple = [
  '#e7f4ea',
  '#c8e6c9',
  '#a5d6a7',
  '#81c784',
  '#66bb6a',
  '#43a047',
  '#2e7d32',
  '#1b6e3a',
  '#1b5e20',
  '#0f3d14',
];
/** --amber #A35C00 (light) and #FFB74D (dark). */
const signal: MantineColorsTuple = [
  '#fff3e0',
  '#ffe0b2',
  '#ffcc80',
  '#ffb74d',
  '#ffa726',
  '#e08600',
  '#a35c00',
  '#8a4b00',
  '#6e3c00',
  '#4a2800',
];
/** Info blue: --blue #1565C0 (light) and #64B5F6 (dark). */
const info: MantineColorsTuple = [
  '#e3f0fc',
  '#bbdefb',
  '#90caf9',
  '#64b5f6',
  '#42a5f5',
  '#1e88e5',
  '#1565c0',
  '#0b57a4',
  '#0d47a1',
  '#082f6b',
];
/** Neutrals from --void to --ink (light). */
const slate: MantineColorsTuple = [
  '#f1f3f6',
  '#eef0f4',
  '#e6e8ec',
  '#d5d9e0',
  '#a3a9b5',
  '#6f7787',
  '#5e6676',
  '#3d4452',
  '#2a303c',
  '#1f2430',
];
/** Mantine dark ramp: [0] text … [4] borders, [6] cards/inputs, [7] body — neutral night. */
const dark: MantineColorsTuple = [
  '#e7e9ee',
  '#c3c8d2',
  '#a3a9b6',
  '#8a91a0',
  '#383e4b',
  '#2a2f3a',
  '#1d2129',
  '#171a21',
  '#14171c',
  '#0f1115',
];

const SHADOW = '0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.03)';
const LIFT = '0 4px 12px -2px rgba(16,24,40,.08), 0 16px 36px -10px rgba(16,24,40,.14)';

/** Light badges, alerts and theme icons use the status pills (tokens follow the scheme). */
const PILL: Record<string, { b: string; t: string }> = {
  ok: { b: 'var(--p-live-b)', t: 'var(--p-live-t)' },
  green: { b: 'var(--p-live-b)', t: 'var(--p-live-t)' },
  signal: { b: 'var(--p-wait-b)', t: 'var(--p-wait-t)' },
  yellow: { b: 'var(--p-wait-b)', t: 'var(--p-wait-t)' },
  breach: { b: 'var(--p-no-b)', t: 'var(--p-no-t)' },
  red: { b: 'var(--p-no-b)', t: 'var(--p-no-t)' },
  info: { b: 'var(--p-blue-b)', t: 'var(--p-blue-t)' },
  blue: { b: 'var(--p-blue-b)', t: 'var(--p-blue-t)' },
  gold: { b: 'var(--p-brand-b)', t: 'var(--p-brand-t)' },
  indigo: { b: 'var(--p-brand-b)', t: 'var(--p-brand-t)' },
  slate: { b: 'var(--p-grey-b)', t: 'var(--p-grey-t)' },
  gray: { b: 'var(--p-grey-b)', t: 'var(--p-grey-t)' },
  field: { b: 'var(--tint)', t: 'var(--link)' },
};

const variantColorResolver: VariantColorsResolver = (input) => {
  const base = defaultVariantColorsResolver(input);
  const name = (input.color ?? input.theme.primaryColor).split('.')[0] ?? '';
  const pill = PILL[name];
  if (input.variant === 'light' && pill) {
    return { ...base, background: pill.b, hover: pill.b, color: pill.t, border: 'none' };
  }
  if (input.variant === 'subtle' && name === 'field') {
    return { ...base, color: 'var(--link)', hover: 'var(--tint)' };
  }
  return base;
};

export const theme = createTheme({
  primaryColor: 'field',
  primaryShade: { light: 6, dark: 5 },
  autoContrast: true,
  variantColorResolver,
  colors: {
    field,
    breach,
    ok,
    signal,
    gold: field,
    indigo: field,
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
  black: '#1f2430',
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
  radius: { xs: '4px', sm: '6px', md: '8px', lg: '12px', xl: '16px' },
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
    Button: { defaultProps: { radius: 'md' }, styles: { root: { minHeight: 40, fontWeight: 600 } } },
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
