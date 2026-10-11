import { useState } from 'react';
import { Alert, Box, Pagination, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconEyeOff, IconShieldCheck } from '@tabler/icons-react';
import { useTeamViolationsVisible, useViolations } from '../../api/queries';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { t } from '../../i18n';
import { ViolationRowCard } from './MyViolationsPage';
import { ViolationDrawer } from './ViolationDrawer';

/**
 * «مخالفات فرقي» (brief §7.6): read-only, own teams only, with responses/objections. The API
 * applies the scope and the visibility; when hidden it returns nothing, and this page explains
 * why instead of showing an empty list.
 */
export function TeamViolationsPage() {
  const { visible, loading } = useTeamViolationsVisible();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const list = useViolations({ page, pageSize: 20 }, visible);

  if (loading) return <LoadingBlock />;
  if (!visible) {
    return (
      <>
        <PageHeader title={t('nav.teamViolations')} />
        <EmptyState icon={IconEyeOff} title={t('teamv.hiddenTitle')} body={t('teamv.hiddenBody')} />
      </>
    );
  }
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <Box maw={1000} mx="auto">
      <PageHeader title={t('nav.teamViolations')} lead={t('teamv.lead')} />
      <Alert color="slate" variant="light" mb="md" icon={<IconShieldCheck size={18} />}>
        <Text size="sm">{t('teamv.readOnly')}</Text>
      </Alert>
      {list.isLoading ? <LoadingBlock /> : null}
      {list.isError ? <ErrorBlock error={list.error} onRetry={() => void list.refetch()} /> : null}
      {data && data.total === 0 ? (
        <EmptyState icon={IconShieldCheck} title={t('teamv.emptyTitle')} body={t('teamv.emptyBody')} />
      ) : null}
      {data && data.total > 0 ? (
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            {data.items.map((v) => (
              <ViolationRowCard key={v.id} v={v} onOpen={() => setOpen(v.id)} />
            ))}
          </SimpleGrid>
          {pages > 1 ? <Pagination value={page} onChange={setPage} total={pages} mt="sm" /> : null}
        </Stack>
      ) : null}
      <ViolationDrawer id={open} onClose={() => setOpen(null)} />
    </Box>
  );
}
