import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Group, Pagination, Table, Text } from '@mantine/core';
import { IconHistory, IconPrinter } from '@tabler/icons-react';
import { useBatches } from '../../api/queries';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { formatDateTime, formatNumber, t } from '../../i18n';

const PAGE_SIZE = 25;

/** Print log (brief §8.1 step 5): who printed which cards, when, with which template. */
export function CardHistoryPage() {
  const [page, setPage] = useState(1);
  const batches = useBatches({ page, pageSize: PAGE_SIZE });
  const pages = batches.data ? Math.max(1, Math.ceil(batches.data.total / PAGE_SIZE)) : 1;
  return (
    <>
      <PageHeader
        title={t('cardHistory.title')}
        lead={t('cardHistory.lead')}
        actions={
          <Button component={Link} to="/cards" leftSection={<IconPrinter size={18} />}>
            {t('cardHistory.newBatch')}
          </Button>
        }
      />
      {batches.isLoading ? (
        <LoadingBlock variant="table" />
      ) : batches.isError ? (
        <ErrorBlock error={batches.error} onRetry={() => void batches.refetch()} />
      ) : !batches.data?.items.length ? (
        <EmptyState icon={IconHistory} title={t('cardHistory.empty')} body={t('cardHistory.emptyBody')} />
      ) : (
        <Card p={0}>
          <Table.ScrollContainer minWidth={560}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('cardHistory.col.at')}</Table.Th>
                  <Table.Th>{t('cardHistory.col.by')}</Table.Th>
                  <Table.Th>{t('cardHistory.col.template')}</Table.Th>
                  <Table.Th>{t('cardHistory.col.count')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {batches.data.items.map((b) => (
                  <Table.Tr key={b.id}>
                    <Table.Td className="mono">{formatDateTime(b.printedAt)}</Table.Td>
                    <Table.Td>{b.printedBy.fullName}</Table.Td>
                    <Table.Td>{b.template.name}</Table.Td>
                    <Table.Td>
                      <Badge variant="light" color="field" className="num">
                        {formatNumber(b.cardCount)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Button
                        variant="subtle"
                        size="compact-sm"
                        component={Link}
                        to={`/cards/print/${b.id}`}
                      >
                        {t('cardHistory.open')}
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}
      {pages > 1 ? (
        <Group justify="flex-end" mt="md">
          <Pagination total={pages} value={page} onChange={setPage} />
        </Group>
      ) : null}
      <Text size="xs" c="dimmed" mt="sm">
        {t('cardHistory.note')}
      </Text>
    </>
  );
}
