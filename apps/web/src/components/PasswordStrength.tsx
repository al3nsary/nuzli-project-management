import { Box, List, Progress, Text, ThemeIcon } from '@mantine/core';
import { IconCheck, IconPoint } from '@tabler/icons-react';
import { t, tKey } from '../i18n';

/** Mirrors the shared `password` schema (≥10 chars, a letter, a digit) and adds length as a bonus. */
export function passwordScore(pw: string) {
  const rules = {
    length: pw.length >= 10,
    letter: /[A-Za-z؀-ۿ]/.test(pw),
    digit: /\d/.test(pw),
    long: pw.length >= 14,
  };
  const variety = /[^A-Za-z0-9؀-ۿ]/.test(pw) || (/[a-z]/.test(pw) && /[A-Z]/.test(pw));
  let score = 0;
  if (pw.length >= 6) score++;
  if (rules.length && rules.letter && rules.digit) score++;
  if (rules.long) score++;
  if (variety && rules.length) score++;
  return { score: Math.min(4, score), rules };
}

const COLORS = ['breach', 'breach', 'signal', 'ok', 'ok'];

export function PasswordStrength({ value }: { value: string }) {
  const { score, rules } = passwordScore(value);
  const items: [keyof typeof rules, boolean][] = [
    ['length', rules.length],
    ['letter', rules.letter],
    ['digit', rules.digit],
    ['long', rules.long],
  ];
  return (
    <Box mt={6} aria-live="polite">
      <Progress value={value ? (score + 1) * 20 : 0} color={COLORS[score]} size="sm" aria-hidden />
      <Text size="xs" mt={4} c="dimmed">
        {t('password.strength', { level: tKey(`password.level.${score}`, 'password.level.0') })}
      </Text>
      <List size="xs" spacing={2} mt={4} center>
        {items.map(([key, ok]) => (
          <List.Item
            key={key}
            icon={
              <ThemeIcon
                size={16}
                radius="xl"
                color={ok ? 'ok' : 'slate'}
                variant={ok ? 'filled' : 'light'}
              >
                {ok ? <IconCheck size={11} /> : <IconPoint size={11} />}
              </ThemeIcon>
            }
          >
            <Text size="xs" c={ok ? undefined : 'dimmed'}>
              {tKey(`password.rule.${key}`, 'password.rule.length')}
            </Text>
          </List.Item>
        ))}
      </List>
    </Box>
  );
}
