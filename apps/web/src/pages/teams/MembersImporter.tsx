import { useState, type ReactNode } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  FileButton,
  Group,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconClipboardText,
  IconFileSpreadsheet,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import type { ImportMembersResultDto, ImportRowResult } from '@nuzli/shared';
import { parsePastedRows, parseXlsx, type ImportRow } from '../../features/members/importRows';
import { errorMessage } from '../../api/errors';
import { FormError } from '../../components/ui';
import { formatNumber, t } from '../../i18n';

type Mode = 'manual' | 'paste' | 'excel';

const EMPTY: ImportRow = { fullName: '', nationalId: '', jobTitle: '', department: '' };

/**
 * Bulk add (brief §5.1): rows typed by hand, pasted from a spreadsheet (tab or comma
 * separated) or read from an .xlsx file in the browser. Nothing is saved before the preview
 * shows each row's errors; only valid rows are committed.
 */
export function MembersImporter({
  onPreview,
  onCommit,
  commitLabel,
  extraActions,
}: {
  onPreview: (rows: ImportRow[]) => Promise<ImportRowResult[]>;
  onCommit: (rows: ImportRow[]) => Promise<ImportMembersResultDto | void>;
  /** Label for the commit button, with `{count}` = valid rows. */
  commitLabel?: (validCount: number) => string;
  extraActions?: ReactNode;
}) {
  const [mode, setMode] = useState<Mode>('manual');
  const [rows, setRows] = useState<ImportRow[]>([{ ...EMPTY }]);
  const [paste, setPaste] = useState('');
  const [results, setResults] = useState<ImportRowResult[] | null>(null);
  const [done, setDone] = useState<ImportMembersResultDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<'preview' | 'commit' | 'file' | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);

  const filled = rows.filter((r) => Object.values(r).some((v) => v && v.trim()));
  const validCount = results ? results.filter((r) => r.ok).length : 0;

  const setRow = (i: number, key: keyof ImportRow, v: string) => {
    setResults(null);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  };

  const loadRows = (incoming: ImportRow[]) => {
    setResults(null);
    setDone(null);
    setRows((rs) => {
      const kept = rs.filter((r) => Object.values(r).some((v) => v && v.trim()));
      return [...kept, ...incoming.map((r) => ({ ...EMPTY, ...r }))];
    });
    setMode('manual');
  };

  const preview = async () => {
    setError(null);
    setBusy('preview');
    try {
      setResults(await onPreview(filled));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const commit = async () => {
    setError(null);
    setBusy('commit');
    try {
      const res = await onCommit(filled);
      if (res) {
        setDone(res);
        setResults(res.results);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const readFile = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setFileNote(null);
    setBusy('file');
    try {
      const parsed = await parseXlsx(file);
      if (!parsed.length) setFileNote(t('import.fileEmpty'));
      else {
        loadRows(parsed);
        setFileNote(t('import.fileRead', { count: parsed.length }));
      }
    } catch (err) {
      setError(new Error(errorMessage(err)));
      setFileNote(t('import.fileUnreadable'));
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    const failed = done.results.filter((r) => !r.ok);
    return (
      <Stack>
        <Alert color="ok" icon={<IconCircleCheck size={18} />}>
          {t('import.committed', { count: done.committed })}
        </Alert>
        {failed.length ? <ResultsTable rows={filled} results={done.results} onlyErrors /> : null}
        {extraActions}
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <SegmentedControl
        value={mode}
        onChange={(v) => setMode(v as Mode)}
        fullWidth
        data={[
          { value: 'manual', label: t('import.mode.manual') },
          { value: 'paste', label: t('import.mode.paste') },
          { value: 'excel', label: t('import.mode.excel') },
        ]}
      />

      {mode === 'paste' ? (
        <Stack gap="xs">
          <Textarea
            label={t('import.pasteLabel')}
            description={t('import.pasteHint')}
            minRows={5}
            autosize
            maxRows={12}
            value={paste}
            onChange={(e) => setPaste(e.currentTarget.value)}
            styles={{ input: { fontFamily: 'var(--font-mono)' } }}
          />
          <Group>
            <Button
              leftSection={<IconClipboardText size={18} />}
              variant="light"
              disabled={!paste.trim()}
              onClick={() => {
                const parsed = parsePastedRows(paste);
                if (parsed.length) {
                  loadRows(parsed);
                  setPaste('');
                }
              }}
            >
              {t('import.readPasted')}
            </Button>
          </Group>
        </Stack>
      ) : null}

      {mode === 'excel' ? (
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            {t('import.excelHint')}
          </Text>
          <Group>
            <FileButton
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(f) => void readFile(f)}
            >
              {(props) => (
                <Button
                  {...props}
                  variant="light"
                  loading={busy === 'file'}
                  leftSection={<IconFileSpreadsheet size={18} />}
                >
                  {t('import.chooseFile')}
                </Button>
              )}
            </FileButton>
          </Group>
          {fileNote ? <Text size="sm">{fileNote}</Text> : null}
        </Stack>
      ) : null}

      {mode === 'manual' ? (
        <Stack gap="xs">
          {rows.map((row, i) => {
            const res = results?.[filled.indexOf(row)];
            return (
              <Box
                key={i}
                className="nz-import-row"
                data-state={res ? (res.ok ? 'ok' : 'error') : undefined}
              >
                <Group gap={6} align="flex-start" wrap="wrap">
                  <Text className="mono" size="xs" c="dimmed" w={22} pt={10} ta="center">
                    {formatNumber(i + 1)}
                  </Text>
                  <TextInput
                    aria-label={t('members.fullName')}
                    placeholder={t('members.fullName')}
                    value={row.fullName ?? ''}
                    onChange={(e) => setRow(i, 'fullName', e.currentTarget.value)}
                    style={{ flex: '2 1 180px' }}
                  />
                  <TextInput
                    aria-label={t('members.nationalId')}
                    placeholder={t('members.nationalId')}
                    value={row.nationalId ?? ''}
                    onChange={(e) => setRow(i, 'nationalId', e.currentTarget.value)}
                    inputMode="numeric"
                    classNames={{ input: 'mono ltr' }}
                    style={{ flex: '1 1 130px' }}
                  />
                  <TextInput
                    aria-label={t('members.jobTitle')}
                    placeholder={t('members.jobTitle')}
                    value={row.jobTitle ?? ''}
                    onChange={(e) => setRow(i, 'jobTitle', e.currentTarget.value)}
                    style={{ flex: '1 1 120px' }}
                  />
                  <TextInput
                    aria-label={t('members.department')}
                    placeholder={t('members.department')}
                    value={row.department ?? ''}
                    onChange={(e) => setRow(i, 'department', e.currentTarget.value)}
                    style={{ flex: '1 1 120px' }}
                  />
                  <ActionIcon
                    variant="subtle"
                    color="slate"
                    size={36}
                    mt={2}
                    aria-label={t('import.removeRow', { row: i + 1 })}
                    onClick={() => {
                      setResults(null);
                      setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : [{ ...EMPTY }]));
                    }}
                  >
                    <IconTrash size={18} />
                  </ActionIcon>
                </Group>
                {res && !res.ok ? (
                  <Text size="xs" c="var(--breach)" ps={28} mt={2}>
                    {res.errors.join(' · ')}
                  </Text>
                ) : null}
              </Box>
            );
          })}
          <Group>
            <Button
              variant="subtle"
              leftSection={<IconPlus size={16} />}
              onClick={() => setRows((rs) => [...rs, { ...EMPTY }])}
            >
              {t('import.addRow')}
            </Button>
          </Group>
        </Stack>
      ) : null}

      {results ? <ResultsTable rows={filled} results={results} /> : null}

      <FormError error={error} />

      <Group justify="space-between" wrap="wrap">
        <Text size="sm" c="dimmed">
          {t('import.rowCount', { count: filled.length })}
        </Text>
        <Group gap="xs">
          {extraActions}
          <Button
            variant={results ? 'default' : 'filled'}
            onClick={() => void preview()}
            loading={busy === 'preview'}
            disabled={!filled.length}
          >
            {t('import.preview')}
          </Button>
          {results ? (
            <Button
              onClick={() => void commit()}
              loading={busy === 'commit'}
              disabled={validCount === 0}
            >
              {commitLabel ? commitLabel(validCount) : t('import.commit', { count: validCount })}
            </Button>
          ) : null}
        </Group>
      </Group>
    </Stack>
  );
}

function ResultsTable({
  rows,
  results,
  onlyErrors,
}: {
  rows: ImportRow[];
  results: ImportRowResult[];
  onlyErrors?: boolean;
}) {
  const ok = results.filter((r) => r.ok).length;
  const shown = onlyErrors ? results.filter((r) => !r.ok) : results;
  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Badge color="ok" variant="light">
          {t('import.validRows', { count: ok })}
        </Badge>
        <Badge color={results.length - ok ? 'breach' : 'slate'} variant="light">
          {t('import.invalidRows', { count: results.length - ok })}
        </Badge>
      </Group>
      <Table.ScrollContainer minWidth={560}>
        <Table fz="sm" withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={48}>{t('import.col.row')}</Table.Th>
              <Table.Th>{t('members.fullName')}</Table.Th>
              <Table.Th>{t('members.nationalId')}</Table.Th>
              <Table.Th>{t('members.jobTitle')}</Table.Th>
              <Table.Th>{t('members.department')}</Table.Th>
              <Table.Th>{t('import.col.result')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {shown.map((r) => (
              <Table.Tr key={r.row} className={r.ok ? undefined : 'nz-row-error'}>
                <Table.Td className="mono">{formatNumber(r.row)}</Table.Td>
                <Table.Td>{r.value?.fullName || rows[r.row - 1]?.fullName || t('common.none')}</Table.Td>
                <Table.Td>
                  <span className="ltr mono">{r.value?.nationalIdMasked || t('common.none')}</span>
                </Table.Td>
                <Table.Td>
                  {r.value?.jobTitle ?? t('common.none')}
                  {r.value?.jobTitle && r.value.jobTitleMatched === false ? (
                    <Text span size="xs" c="dimmed">
                      {' '}
                      ({t('import.freeText')})
                    </Text>
                  ) : null}
                </Table.Td>
                <Table.Td>
                  {r.value?.department ?? t('common.none')}
                  {r.value?.department && r.value.departmentMatched === false ? (
                    <Text span size="xs" c="dimmed">
                      {' '}
                      ({t('import.freeText')})
                    </Text>
                  ) : null}
                </Table.Td>
                <Table.Td>
                  {r.ok ? (
                    <Group gap={4} wrap="nowrap" c="var(--ok)">
                      <IconCircleCheck size={16} aria-hidden />
                      <Text size="sm">{t('import.ok')}</Text>
                    </Group>
                  ) : (
                    <Group gap={4} wrap="nowrap" align="flex-start" c="var(--breach)">
                      <IconAlertTriangle size={16} aria-hidden style={{ flex: 'none', marginTop: 3 }} />
                      <Text size="sm">{r.errors.join(' · ')}</Text>
                    </Group>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}
