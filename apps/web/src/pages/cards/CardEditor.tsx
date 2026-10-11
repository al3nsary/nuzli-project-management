import { useMemo } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Grid,
  Group,
  Stack,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconArrowBackUp, IconPencil } from '@tabler/icons-react';
import { WorkCard } from '@nuzli/ui-print';
import type { CardData, CardTemplateDto } from '@nuzli/shared';
import { formatNumber, t } from '../../i18n';
import { CardStyles, FitCard, toTemplateLike } from './cardUtils';

/** One card of the batch: the server preview plus this batch's edits (brief §8.1). */
export interface EditableCard {
  key: string;
  memberId?: string;
  userId?: string;
  original: CardData;
  data: CardData;
  selected: boolean;
  /** Write name / job title / department back to the member record. Members only. */
  saveBack: boolean;
}

const FIELDS = ['fullName', 'jobTitle', 'nationalId', 'department', 'teamName', 'validUntil'] as const;
type Field = (typeof FIELDS)[number];

export const isEdited = (c: EditableCard) =>
  FIELDS.some((f) => (c.data[f] ?? '') !== (c.original[f] ?? ''));

/**
 * Live preview grid with an inline form beside it: every printed field is editable per card.
 * Edits stay in this batch unless «حفظ في سجل العضو» is ticked.
 */
export function CardEditor({
  template,
  logoUrl,
  cards,
  activeKey,
  onActivate,
  onChange,
}: {
  template: CardTemplateDto;
  logoUrl: string | null;
  cards: EditableCard[];
  activeKey: string | null;
  onActivate: (key: string | null) => void;
  onChange: (cards: EditableCard[]) => void;
}) {
  const like = useMemo(() => toTemplateLike(template), [template]);
  const active = cards.find((c) => c.key === activeKey) ?? null;
  const selectedCount = cards.filter((c) => c.selected).length;

  const update = (key: string, patch: Partial<EditableCard>) =>
    onChange(cards.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const setField = (key: string, field: Field, value: string) => {
    const card = cards.find((c) => c.key === key);
    if (card) update(key, { data: { ...card.data, [field]: value } });
  };

  return (
    <>
      <CardStyles />
      <Group justify="space-between" mb="sm" wrap="wrap" gap="xs">
        <Text size="sm" c="dimmed">
          {t('cards.selectedOf', { selected: selectedCount, total: cards.length })}
        </Text>
        <Group gap="xs">
          <Button
            variant="subtle"
            size="compact-sm"
            onClick={() => onChange(cards.map((c) => ({ ...c, selected: true })))}
          >
            {t('cards.selectAll')}
          </Button>
          <Button
            variant="subtle"
            size="compact-sm"
            onClick={() => onChange(cards.map((c) => ({ ...c, selected: false })))}
          >
            {t('cards.selectNone')}
          </Button>
        </Group>
      </Group>
      <Grid gutter="md">
        <Grid.Col span={{ base: 12, md: 4 }} order={{ base: 1, md: 2 }}>
          <Card className="nz-card-editor" data-testid="card-editor">
            {active ? (
              <Stack gap="sm">
                <Group justify="space-between" wrap="nowrap">
                  <Title order={3} fz="md">
                    {t('cards.editTitle')}
                  </Title>
                  {isEdited(active) ? (
                    <Button
                      variant="subtle"
                      size="compact-sm"
                      leftSection={<IconArrowBackUp size={14} className="mirror-rtl" />}
                      onClick={() => update(active.key, { data: { ...active.original }, saveBack: false })}
                    >
                      {t('cards.resetCard')}
                    </Button>
                  ) : null}
                </Group>
                <TextInput
                  label={t('cards.field.fullName')}
                  value={active.data.fullName ?? ''}
                  onChange={(e) => setField(active.key, 'fullName', e.currentTarget.value)}
                  maxLength={120}
                />
                <TextInput
                  label={t('cards.field.jobTitle')}
                  value={active.data.jobTitle ?? ''}
                  onChange={(e) => setField(active.key, 'jobTitle', e.currentTarget.value)}
                  maxLength={80}
                />
                <TextInput
                  label={t('cards.field.nationalId')}
                  description={
                    template.config.maskNationalId ? t('cards.field.nationalIdMasked') : undefined
                  }
                  value={active.data.nationalId ?? ''}
                  onChange={(e) => setField(active.key, 'nationalId', e.currentTarget.value)}
                  classNames={{ input: 'ltr mono' }}
                  maxLength={20}
                />
                <TextInput
                  label={t('cards.field.department')}
                  value={active.data.department ?? ''}
                  onChange={(e) => setField(active.key, 'department', e.currentTarget.value)}
                  maxLength={80}
                />
                <TextInput
                  label={t('cards.field.teamName')}
                  value={active.data.teamName ?? ''}
                  onChange={(e) => setField(active.key, 'teamName', e.currentTarget.value)}
                  maxLength={80}
                />
                <TextInput
                  type="date"
                  label={t('cards.field.validUntil')}
                  value={active.data.validUntil ?? ''}
                  onChange={(e) => setField(active.key, 'validUntil', e.currentTarget.value)}
                  classNames={{ input: 'ltr mono' }}
                />
                {active.memberId ? (
                  <Checkbox
                    checked={active.saveBack}
                    onChange={(e) => update(active.key, { saveBack: e.currentTarget.checked })}
                    label={t('cards.saveBack')}
                    description={t('cards.saveBackHint')}
                    disabled={!isEdited(active)}
                  />
                ) : (
                  <Text size="xs" c="dimmed">
                    {t('cards.supervisorNoSaveBack')}
                  </Text>
                )}
                <Button variant="default" onClick={() => onActivate(null)}>
                  {t('cards.doneEditing')}
                </Button>
              </Stack>
            ) : (
              <Stack gap={6}>
                <Group gap="xs">
                  <IconPencil size={18} aria-hidden />
                  <Text fw={600}>{t('cards.editHintTitle')}</Text>
                </Group>
                <Text size="sm" c="dimmed">
                  {t('cards.editHint')}
                </Text>
              </Stack>
            )}
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 8 }} order={{ base: 2, md: 1 }}>
          <div className="nz-card-grid" role="list" aria-label={t('cards.previewList')}>
            {cards.map((c, i) => (
              <Box
                key={c.key}
                role="listitem"
                className="nz-card-cell"
                data-active={c.key === activeKey || undefined}
                data-selected={c.selected || undefined}
              >
                <Group justify="space-between" mb={6} wrap="nowrap" gap={6}>
                  <Checkbox
                    size="sm"
                    checked={c.selected}
                    onChange={(e) => update(c.key, { selected: e.currentTarget.checked })}
                    label={
                      <Text size="sm" fw={500} truncate maw={180}>
                        {formatNumber(i + 1)}. {c.data.fullName}
                      </Text>
                    }
                  />
                  <Group gap={4} wrap="nowrap">
                    {c.userId ? (
                      <Badge size="xs" color="slate" variant="outline">
                        {t('role.SUPERVISOR')}
                      </Badge>
                    ) : null}
                    {isEdited(c) ? (
                      <Badge size="xs" color="signal" variant="light">
                        {c.saveBack ? t('cards.editedSaved') : t('cards.edited')}
                      </Badge>
                    ) : null}
                  </Group>
                </Group>
                <UnstyledButton
                  onClick={() => onActivate(c.key)}
                  aria-label={t('cards.editCard', { name: c.data.fullName })}
                  style={{ display: 'block', width: '100%' }}
                >
                  <FitCard template={like}>
                    <WorkCard template={like} data={c.data} logoUrl={logoUrl} />
                  </FitCard>
                </UnstyledButton>
              </Box>
            ))}
          </div>
        </Grid.Col>
      </Grid>
    </>
  );
}
