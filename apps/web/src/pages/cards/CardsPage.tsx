import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Group,
  MultiSelect,
  Radio,
  SimpleGrid,
  Stack,
  Stepper,
  Switch,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import {
  IconHistory,
  IconPrinter,
  IconRulerMeasure,
  IconTemplate,
} from '@tabler/icons-react';
import { WorkCard } from '@nuzli/ui-print';
import { can, type CardTemplateDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import {
  useAllMembers,
  useCardTemplates,
  useInvalidateTeams,
  useLogos,
  useTeams,
} from '../../api/queries';
import { useAuthStore } from '../../stores/auth';
import { EmptyState, ErrorBlock, FormError, LoadingBlock, PageHeader } from '../../components/ui';
import { TeamBadge } from '../../theme/TeamBadge';
import { formatNumber, t, tKey, tCount } from '../../i18n';
import { CardEditor, type EditableCard } from './CardEditor';
import { CardStyles, FitCard, SAMPLE_CARD, logoFor, toTemplateLike } from './cardUtils';
import { putPrintRun } from '../../features/cards/printRun';
import { canChangeMemberPhoto, canChangeUserPhoto } from '../../features/photos/access';

function TemplateChoice({
  template,
  logoUrl,
}: {
  template: CardTemplateDto;
  logoUrl: string | null;
}) {
  const like = toTemplateLike(template);
  return (
    <Radio.Card value={template.id} className="nz-template-choice" radius="md" p="sm">
      <Group wrap="nowrap" align="flex-start" gap="sm" mb="xs">
        <Radio.Indicator />
        <div style={{ minWidth: 0 }}>
          <Text fw={600}>{template.name}</Text>
          <Text size="xs" c="dimmed">
            {template.size.name} · {tKey(`cards.orientation.${template.orientation}`, 'common.none')} ·{' '}
            {tKey(`cards.layout.${template.layoutKey}`, 'common.none')}
          </Text>
        </div>
      </Group>
      <FitCard template={like} max={0.8}>
        <WorkCard template={like} data={SAMPLE_CARD} logoUrl={logoUrl} />
      </FitCard>
    </Radio.Card>
  );
}

/**
 * Work cards (brief §8.1): choose teams or members → choose a template → edit the live
 * preview → print. Every batch is logged through the API with an idempotency key.
 */
export function CardsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const invalidateTeams = useInvalidateTeams();
  const user = useAuthStore((s) => s.user);
  const teams = useTeams({});
  const members = useAllMembers();
  const templates = useCardTemplates();
  const logos = useLogos();

  const [step, setStep] = useState(0);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [includeSupervisors, setIncludeSupervisors] = useState(true);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [cards, setCards] = useState<EditableCard[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** One idempotency key per print attempt; a retry after a failure reuses it. */
  const attemptKey = useRef<string | null>(null);

  useEffect(() => {
    if (!templateId && templates.data?.length)
      setTemplateId((templates.data.find((x) => x.isDefault) ?? templates.data[0])!.id);
  }, [templates.data, templateId]);

  // Any change to what would be printed starts a new attempt.
  useEffect(() => {
    attemptKey.current = null;
  }, [cards, templateId]);

  const template = templates.data?.find((x) => x.id === templateId);
  const logoUrl = logoFor(template, logos.data);
  const selected = cards.filter((c) => c.selected);
  const memberOptions = useMemo(
    () =>
      (members.data ?? []).map((m) => ({
        value: m.id,
        label: m.team ? `${m.fullName} — ${m.team.name}` : m.fullName,
      })),
    [members.data],
  );

  const loadPreview = async () => {
    if (!templateId) return;
    setError(null);
    setLoading(true);
    try {
      const res = await api.cards.preview({ templateId, teamIds, memberIds, includeSupervisors });
      setCards(
        res.subjects.map((s, i) => ({
          key: s.memberId ? `m:${s.memberId}` : s.userId ? `u:${s.userId}` : `x:${i}`,
          memberId: s.memberId,
          userId: s.userId,
          original: { ...s.data },
          data: { ...s.data },
          selected: true,
          saveBack: false,
          photoUrl: s.photoUrl ?? null,
        })),
      );
      setActiveKey(null);
      setStep(2);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  /**
   * A8: after a photo changes in the editor, ask the preview again and take only the photo
   * (URL and file id) — the batch edits stay as they are.
   */
  const refreshPhotos = async () => {
    if (!templateId) return;
    try {
      const res = await api.cards.preview({ templateId, teamIds, memberIds, includeSupervisors });
      const byKey = new Map(
        res.subjects.map((s) => [s.memberId ? `m:${s.memberId}` : `u:${s.userId}`, s] as const),
      );
      setCards((prev) =>
        prev.map((c) => {
          const s = byKey.get(c.key);
          if (!s) return c;
          const photoFileId = s.data.photoFileId ?? null;
          return {
            ...c,
            photoUrl: s.photoUrl ?? null,
            original: { ...c.original, photoFileId },
            data: { ...c.data, photoFileId },
          };
        }),
      );
    } catch (err) {
      setError(err);
    }
  };

  const canChangePhoto = (c: EditableCard) => {
    if (c.memberId) {
      const m = members.data?.find((x) => x.id === c.memberId);
      return canChangeMemberPhoto(user, m ?? { team: null }, teams.data);
    }
    return c.userId ? canChangeUserPhoto(user, c.userId) : false;
  };

  const print = async () => {
    if (!template || !selected.length) return;
    setError(null);
    setPrinting(true);
    attemptKey.current ??= crypto.randomUUID();
    try {
      const batch = await api.cards.createBatch({
        idempotencyKey: attemptKey.current,
        templateId: template.id,
        items: selected.map((c) => ({
          memberId: c.memberId ?? null,
          userId: c.userId ?? null,
          data: c.data,
          saveBack: c.saveBack,
        })),
      });
      attemptKey.current = null;
      putPrintRun(batch.id, batch.cards);
      void qc.invalidateQueries({ queryKey: ['cards', 'batches'] });
      if (selected.some((c) => c.saveBack)) await invalidateTeams();
      notifications.show({ color: 'ok', message: t('cards.batchLogged', { count: batch.cardCount }) });
      navigate(`/cards/print/${batch.id}?auto=1`);
    } catch (err) {
      setError(err);
    } finally {
      setPrinting(false);
    }
  };

  if (templates.isLoading || teams.isLoading) return <LoadingBlock variant="cards" header />;
  if (templates.isError) return <ErrorBlock error={templates.error} onRetry={() => void templates.refetch()} />;

  const nothingChosen = teamIds.length === 0 && memberIds.length === 0;

  return (
    <>
      <PageHeader
        title={t('cards.title')}
        lead={t('cards.lead')}
        actions={
          <>
            <Button variant="subtle" component={Link} to="/cards/history" leftSection={<IconHistory size={18} />}>
              {t('nav.cardHistory')}
            </Button>
            {can(user, 'cards.manageTemplates') ? (
              <Button
                variant="subtle"
                component={Link}
                to="/cards/templates?tab=sizes"
                leftSection={<IconRulerMeasure size={18} />}
              >
                {t('cards.sizesAndTest')}
              </Button>
            ) : null}
          </>
        }
      />
      <Stepper active={step} onStepClick={(s) => s < step && setStep(s)} size="sm" mb="lg">
        <Stepper.Step label={t('cards.step.who')} />
        <Stepper.Step label={t('cards.step.template')} />
        <Stepper.Step label={t('cards.step.preview')} />
      </Stepper>
      <FormError error={error} />

      {step === 0 ? (
        <Stack gap="md">
          <Card>
            <Title order={2} fz="lg" mb="sm">
              {t('cards.chooseTeams')}
            </Title>
            {teams.data?.length ? (
              <Checkbox.Group value={teamIds} onChange={setTeamIds}>
                <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="xs">
                  {teams.data.map((tm) => (
                    <Checkbox.Card key={tm.id} value={tm.id} className="nz-check-card" radius="md">
                      <Group wrap="nowrap" gap="sm" p="xs">
                        <Checkbox.Indicator />
                        <TeamBadge name={tm.name} color={tm.color.hex} size="sm" />
                        <Text size="xs" c="dimmed" ms="auto" className="num" style={{ flex: 'none' }}>
                          {tCount('teams.memberCount', tm.memberCount)}
                        </Text>
                      </Group>
                    </Checkbox.Card>
                  ))}
                </SimpleGrid>
              </Checkbox.Group>
            ) : (
              <Text c="dimmed">{t('teams.empty')}</Text>
            )}
            <Switch
              mt="md"
              checked={includeSupervisors}
              onChange={(e) => setIncludeSupervisors(e.currentTarget.checked)}
              label={t('cards.includeSupervisors')}
            />
          </Card>
          <Card>
            <Title order={2} fz="lg" mb="sm">
              {t('cards.chooseMembers')}
            </Title>
            <MultiSelect
              aria-label={t('cards.chooseMembers')}
              placeholder={t('cards.membersPlaceholder')}
              data={memberOptions}
              value={memberIds}
              onChange={setMemberIds}
              searchable
              clearable
              limit={50}
              nothingFoundMessage={t('members.empty')}
            />
          </Card>
          <Group justify="flex-end">
            <Button disabled={nothingChosen} onClick={() => setStep(1)}>
              {t('cards.next')}
            </Button>
          </Group>
        </Stack>
      ) : null}

      {step === 1 ? (
        <Stack gap="md">
          <CardStyles />
          {templates.data?.length ? (
            <Radio.Group value={templateId} onChange={setTemplateId} aria-label={t('cards.chooseTemplate')}>
              <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
                {templates.data.map((tpl) => (
                  <TemplateChoice key={tpl.id} template={tpl} logoUrl={logoFor(tpl, logos.data)} />
                ))}
              </SimpleGrid>
            </Radio.Group>
          ) : (
            <EmptyState
              icon={IconTemplate}
              title={t('templates.empty')}
              action={
                can(user, 'cards.manageTemplates')
                  ? { label: t('nav.cardTemplates'), onClick: () => navigate('/cards/templates') }
                  : undefined
              }
            />
          )}
          <Group justify="space-between">
            <Button variant="default" onClick={() => setStep(0)}>
              {t('common.back')}
            </Button>
            <Button disabled={!templateId} loading={loading} onClick={() => void loadPreview()}>
              {t('cards.showPreview')}
            </Button>
          </Group>
        </Stack>
      ) : null}

      {step === 2 && template ? (
        <Stack gap="md">
          {cards.length === 0 ? (
            <Alert color="signal">{t('cards.noSubjects')}</Alert>
          ) : (
            <CardEditor
              template={template}
              logoUrl={logoUrl}
              cards={cards}
              activeKey={activeKey}
              onActivate={setActiveKey}
              onChange={setCards}
              canChangePhoto={canChangePhoto}
              onPhotoChanged={() => void refreshPhotos()}
            />
          )}
          <Card className="nz-print-bar" withBorder shadow="md" p="sm">
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Button variant="default" onClick={() => setStep(1)} px="sm">
                {t('cards.changeTemplate')}
              </Button>
              <Group gap="sm" wrap="nowrap">
                <Text size="sm" c="dimmed" visibleFrom="md">
                  {t('cards.templateIs', { name: template.name })}
                </Text>
                <Button
                  leftSection={<IconPrinter size={18} />}
                  disabled={!selected.length}
                  loading={printing}
                  onClick={() => void print()}
                >
                  {t('cards.printN', { count: formatNumber(selected.length) })}
                </Button>
              </Group>
            </Group>
          </Card>
        </Stack>
      ) : null}
    </>
  );
}
