import type { ReactNode } from 'react';
import { Box, Stack, Text, Title } from '@mantine/core';
import { IS_DEMO } from '../../api';
import { t } from '../../i18n';
import { VestBand } from '../../theme/VestBand';

/**
 * Public pages: a quiet --ink brand column on the inline-start (right in RTL) on wide screens,
 * the form on --ground. On phones the brand collapses into a compact header.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  width = 440,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  width?: number;
}) {
  return (
    <Box
      mih="100dvh"
      style={{ display: 'flex', flexDirection: 'column', background: 'var(--ground)' }}
    >
      {IS_DEMO ? (
        <div className="demo-strip" role="note">
          {t('shell.demoStrip')}
        </div>
      ) : null}
      <Box style={{ flex: 1, display: 'flex' }}>
        <Box
          visibleFrom="md"
          style={{
            flex: '0 0 380px',
            background: 'var(--sidebar)',
            color: 'var(--sidebar-text)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: 40,
          }}
        >
          <VestBand color="#5FB3B8">
            <Text className="display" fz="2.25rem" lh={1.15} c="var(--sidebar-text)">
              {t('app.name')}
            </Text>
            <Text c="var(--sidebar-muted)" mt={4}>
              {t('app.tagline')}
            </Text>
          </VestBand>
          <Text fz="sm" c="var(--sidebar-muted)" maw={280}>
            {t('auth.sideNote')}
          </Text>
        </Box>
        <Box
          style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}
          px="md"
          py={{ base: 'lg', sm: 56 }}
        >
          <Stack w="100%" maw={width} gap="lg">
            <Box hiddenFrom="md">
              <VestBand>
                <Text className="display" fz="1.75rem" lh={1.2}>
                  {t('app.name')}
                </Text>
                <Text c="dimmed" fz="sm">
                  {t('app.tagline')}
                </Text>
              </VestBand>
            </Box>
            <Box>
              <Title order={1}>{title}</Title>
              {subtitle ? (
                <Text c="dimmed" mt={4}>
                  {subtitle}
                </Text>
              ) : null}
            </Box>
            {children}
          </Stack>
        </Box>
      </Box>
    </Box>
  );
}
