import { createTheme, type CSSVariablesResolver, type MantineColorsTuple } from '@mantine/core';

/** Field teal, centred on --field #1D5C63 (index 6, light) and #5FB3B8 (index 3, dark). */
const field: MantineColorsTuple = [
  '#e8f4f5',
  '#c9e5e7',
  '#94cdd1',
  '#5fb3b8',
  '#3e959b',
  '#2b777e',
  '#1d5c63',
  '#174d53',
  '#113d42',
  '#0b2c30',
];
/** Breach red, centred on --breach #B42318 (light) and #F06A5E (dark). */
const breach: MantineColorsTuple = [
  '#fdeceb',
  '#f9d0cc',
  '#f4a39b',
  '#f06a5e',
  '#d9453a',
  '#c4322a',
  '#b42318',
  '#951c13',
  '#76150f',
  '#570f0a',
];
/** OK green, centred on --ok #2E7D4F (light) and #5CC48A (dark). */
const ok: MantineColorsTuple = [
  '#e9f6ee',
  '#c9e9d5',
  '#95d4ad',
  '#5cc48a',
  '#3fa36b',
  '#348c5b',
  '#2e7d4f',
  '#256641',
  '#1c4f32',
  '#133823',
];
/** Signal amber, centred on --signal #E8A317 (light) and #F2B84B (dark). */
const signal: MantineColorsTuple = [
  '#fdf5e3',
  '#fae6bb',
  '#f6d385',
  '#f2b84b',
  '#eeac2c',
  '#eba61f',
  '#e8a317',
  '#c1860f',
  '#94660b',
  '#674707',
];
/** Neutral ramp from --ground to --ink, used for gray/dark components. */
const slate: MantineColorsTuple = [
  '#eef1f1',
  '#dfe5e6',
  '#d3dbdc',
  '#b6c2c5',
  '#93a4ab',
  '#5b6b72',
  '#3c4d55',
  '#2a3a42',
  '#16232a',
  '#0e171c',
];

/**
 * Mantine dark-scheme ramp: [0] text … [4] borders, [6] cards/inputs, [7] body.
 * Mapped onto the Nuzli dark tokens (--ink, --muted, --line, --surface, --ground).
 */
const dark: MantineColorsTuple = [
  '#e6ecee',
  '#c5d0d4',
  '#93a4ab',
  '#6b7c84',
  '#2a3a42',
  '#22313a',
  '#16232a',
  '#0e171c',
  '#0a1216',
  '#060c0f',
];

const SHADOW = '0 1px 2px rgb(20 35 43 / .06), 0 4px 12px rgb(20 35 43 / .05)';

export const theme = createTheme({
  primaryColor: 'field',
  primaryShade: { light: 6, dark: 3 },
  autoContrast: true,
  colors: {
    field,
    breach,
    ok,
    signal,
    slate,
    red: breach,
    green: ok,
    yellow: signal,
    gray: slate,
    dark,
  },
  fontFamily: "'IBM Plex Sans Arabic', system-ui, sans-serif",
  fontFamilyMonospace: "'IBM Plex Mono', ui-monospace, monospace",
  headings: {
    fontFamily: "'Readex Pro Variable', 'IBM Plex Sans Arabic', sans-serif",
    fontWeight: '600',
    sizes: {
      h1: { fontSize: '1.75rem', lineHeight: '1.3' },
      h2: { fontSize: '1.375rem', lineHeight: '1.3' },
      h3: { fontSize: '1.125rem', lineHeight: '1.3' },
      h4: { fontSize: '1rem', lineHeight: '1.3' },
    },
  },
  fontSizes: { xs: '0.75rem', sm: '0.875rem', md: '1rem', lg: '1.125rem', xl: '1.375rem' },
  lineHeights: { xs: '1.6', sm: '1.7', md: '1.7', lg: '1.6', xl: '1.5' },
  spacing: { xs: '8px', sm: '12px', md: '16px', lg: '24px', xl: '32px' },
  radius: { xs: '4px', sm: '8px', md: '8px', lg: '10px', xl: '999px' },
  defaultRadius: 'md',
  shadows: { xs: SHADOW, sm: SHADOW, md: SHADOW, lg: SHADOW, xl: SHADOW },
  focusRing: 'auto',
  respectReducedMotion: true,
  cursorType: 'pointer',
  components: {
    Card: { defaultProps: { radius: 'lg', withBorder: true, shadow: 'sm', padding: 'lg' } },
    Paper: { defaultProps: { radius: 'lg' } },
    Modal: { defaultProps: { radius: 'lg', centered: true } },
    Badge: { defaultProps: { radius: 'xl', variant: 'light' } },
    Table: { defaultProps: { highlightOnHover: true, striped: false, verticalSpacing: 'sm' } },
    Button: { defaultProps: { radius: 'md' }, styles: { root: { minHeight: 44 } } },
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
    '--mantine-color-body': 'var(--surface)',
    '--mantine-color-text': 'var(--ink)',
    '--mantine-color-dimmed': 'var(--muted)',
    '--mantine-color-default-border': 'var(--line)',
    '--mantine-color-default': 'var(--surface)',
    '--mantine-color-placeholder': 'var(--muted)',
    '--mantine-color-anchor': 'var(--field)',
    '--mantine-color-error': 'var(--breach)',
  };
  return { variables: {}, light: common, dark: common };
};
