import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  ColorInput,
  FileButton,
  Grid,
  Group,
  Image,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import {
  IconLock,
  IconPhotoUp,
  IconPlus,
  IconPrinter,
  IconStar,
  IconTrash,
} from '@tabler/icons-react';
import { DEFAULT_CARD_CONFIG, WorkCard } from '@nuzli/ui-print';
import {
  cardSizeSchema,
  cardTemplateSchema,
  type CardLayoutKey,
  type CardOrientation,
  type CardTemplateConfig,
  type CardTemplateDto,
} from '@nuzli/shared';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/errors';
import { qk2, useCardSizes, useCardTemplates, useLogos } from '../../api/queries';
import { ErrorBlock, FormError, LoadingBlock, PageHeader } from '../../components/ui';
import { formatNumber, t } from '../../i18n';
import { CardStyles, FitCard, SAMPLE_CARD } from './cardUtils';

const LAYOUTS: CardLayoutKey[] = ['CLASSIC_HORIZONTAL', 'VERTICAL_BADGE', 'COMPACT_LABEL'];
const FIELD_KEYS = [
  'logo',
  'jobTitle',
  'nationalId',
  'department',
  'teamName',
  'photo',
  'qr',
  'validUntil',
] as const;

interface FormState {
  id: string | null;
  name: string;
  sizeId: string | null;
  orientation: CardOrientation;
  layoutKey: CardLayoutKey;
  config: CardTemplateConfig;
  isDefault: boolean;
  logoId: string | null;
}

const blank = (sizeId: string | null): FormState => ({
  id: null,
  name: '',
  sizeId,
  orientation: 'LANDSCAPE',
  layoutKey: 'CLASSIC_HORIZONTAL',
  config: structuredClone(DEFAULT_CARD_CONFIG),
  isDefault: false,
  logoId: null,
});

const fromDto = (tpl: CardTemplateDto): FormState => ({
  id: tpl.id,
  name: tpl.name,
  sizeId: tpl.size.id,
  orientation: tpl.orientation,
  layoutKey: tpl.layoutKey,
  config: structuredClone(tpl.config),
  isDefault: tpl.isDefault,
  logoId: tpl.logoId,
});

function useInvalidateCards() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['cards'] }),
      qc.invalidateQueries({ queryKey: qk2.logos }),
      qc.invalidateQueries({ queryKey: ['audit'] }),
    ]);
}

// ---------------------------------------------------------------- templates

function TemplateEditor() {
  const api = useApi();
  const invalidate = useInvalidateCards();
  const templates = useCardTemplates();
  const sizes = useCardSizes();
  const logos = useLogos();
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!form && templates.data?.length) setForm(fromDto(templates.data[0]!));
  }, [templates.data, form]);

  const size = sizes.data?.find((s) => s.id === form?.sizeId);
  const preview = useMemo(
    () =>
      form && size
        ? {
            size,
            orientation: form.orientation,
            layoutKey: form.layoutKey,
            config: form.config,
          }
        : null,
    [form, size],
  );
  const logoUrl =
    (form?.logoId
      ? logos.data?.find((l) => l.id === form.logoId)
      : logos.data?.find((l) => l.isDefault))?.url ?? null;

  if (templates.isLoading || sizes.isLoading) return <LoadingBlock />;
  if (templates.isError) return <ErrorBlock error={templates.error} />;
  if (!form) return null;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm({ ...form, [k]: v });
  const setConfig = (patch: Partial<CardTemplateConfig>) =>
    setForm({ ...form, config: { ...form.config, ...patch } });

  const save = async () => {
    const input = {
      name: form.name,
      sizeId: form.sizeId ?? '',
      orientation: form.orientation,
      layoutKey: form.layoutKey,
      config: form.config,
      isDefault: form.isDefault,
      logoId: form.logoId,
    };
    const parsed = cardTemplateSchema.safeParse(input);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[i.path.join('.')] ??= i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    setError(null);
    setBusy(true);
    try {
      const saved = form.id
        ? await api.cards.updateTemplate(form.id, input)
        : await api.cards.createTemplate(input);
      await invalidate();
      setForm(fromDto(saved));
      notifications.show({ color: 'ok', message: t('templates.saved', { name: saved.name }) });
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!form.id) return;
    setBusy(true);
    try {
      await api.cards.archiveTemplate(form.id);
      await invalidate();
      setForm(null);
      notifications.show({ color: 'ok', message: t('templates.archived') });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Grid gutter="lg">
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Stack gap="md">
          <Group gap="xs" wrap="wrap">
            <Select
              aria-label={t('templates.choose')}
              data={(templates.data ?? []).map((x) => ({
                value: x.id,
                label: x.isDefault ? `${x.name} (${t('templates.default')})` : x.name,
              }))}
              value={form.id}
              onChange={(id) => {
                const tpl = templates.data?.find((x) => x.id === id);
                if (tpl) setForm(fromDto(tpl));
              }}
              placeholder={t('templates.new')}
              style={{ flex: '1 1 240px' }}
            />
            <Button
              variant="light"
              leftSection={<IconPlus size={18} />}
              onClick={() => setForm(blank(sizes.data?.[0]?.id ?? null))}
            >
              {t('templates.new')}
            </Button>
          </Group>
          <FormError error={error} />
          <Card>
            <Stack gap="sm">
              <TextInput
                label={t('templates.name')}
                value={form.name}
                onChange={(e) => set('name', e.currentTarget.value)}
                error={errors.name}
              />
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <Select
                  label={t('templates.size')}
                  data={(sizes.data ?? []).map((s) => ({
                    value: s.id,
                    label: `${s.name} — ${formatNumber(s.widthMm)} × ${formatNumber(s.heightMm)} ${t('common.mm')}`,
                  }))}
                  value={form.sizeId}
                  onChange={(v) => set('sizeId', v)}
                  error={errors.sizeId}
                  allowDeselect={false}
                />
                <Select
                  label={t('templates.layout')}
                  data={LAYOUTS.map((l) => ({ value: l, label: t(`cards.layout.${l}`) }))}
                  value={form.layoutKey}
                  onChange={(v) => v && set('layoutKey', v as CardLayoutKey)}
                  allowDeselect={false}
                />
              </SimpleGrid>
              <Box>
                <Text size="sm" fw={500} mb={4}>
                  {t('templates.orientation')}
                </Text>
                <SegmentedControl
                  value={form.orientation}
                  onChange={(v) => set('orientation', v as CardOrientation)}
                  data={[
                    { value: 'LANDSCAPE', label: t('cards.orientation.LANDSCAPE') },
                    { value: 'PORTRAIT', label: t('cards.orientation.PORTRAIT') },
                  ]}
                />
              </Box>
            </Stack>
          </Card>
          <Card>
            <Title order={3} fz="md" mb="sm">
              {t('templates.fields')}
            </Title>
            <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="xs">
              {FIELD_KEYS.map((k) => (
                <Switch
                  key={k}
                  label={t(`templates.field.${k}`)}
                  checked={form.config.fields[k]}
                  onChange={(e) =>
                    setConfig({ fields: { ...form.config.fields, [k]: e.currentTarget.checked } })
                  }
                />
              ))}
            </SimpleGrid>
            <Switch
              mt="md"
              label={t('templates.maskId')}
              description={t('templates.maskIdHint')}
              checked={form.config.maskNationalId}
              onChange={(e) => setConfig({ maskNationalId: e.currentTarget.checked })}
            />
            {form.config.fields.validUntil ? (
              <TextInput
                mt="sm"
                type="date"
                label={t('templates.validUntil')}
                value={form.config.validUntil ?? ''}
                onChange={(e) => setConfig({ validUntil: e.currentTarget.value || undefined })}
                classNames={{ input: 'ltr mono' }}
                maw={220}
              />
            ) : null}
          </Card>
          <Card>
            <Title order={3} fz="md" mb="sm">
              {t('templates.look')}
            </Title>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <Select
                label={t('templates.logo')}
                data={[
                  { value: '', label: t('templates.logoDefault') },
                  ...(logos.data ?? []).map((l) => ({ value: l.id, label: l.name })),
                ]}
                value={form.logoId ?? ''}
                onChange={(v) => set('logoId', v ? v : null)}
                allowDeselect={false}
              />
              <Select
                label={t('templates.logoPosition')}
                data={(['start', 'center', 'end'] as const).map((p) => ({
                  value: p,
                  label: t(`templates.pos.${p}`),
                }))}
                value={form.config.logoPosition}
                onChange={(v) => v && setConfig({ logoPosition: v as CardTemplateConfig['logoPosition'] })}
                allowDeselect={false}
              />
              <NumberInput
                label={t('templates.nameSize')}
                min={5}
                max={30}
                step={0.5}
                decimalScale={1}
                value={form.config.fontSizes.name}
                onChange={(v) =>
                  typeof v === 'number' &&
                  setConfig({ fontSizes: { ...form.config.fontSizes, name: v } })
                }
              />
              <NumberInput
                label={t('templates.bodySize')}
                min={4}
                max={20}
                step={0.5}
                decimalScale={1}
                value={form.config.fontSizes.body}
                onChange={(v) =>
                  typeof v === 'number' &&
                  setConfig({ fontSizes: { ...form.config.fontSizes, body: v } })
                }
              />
              <Select
                label={t('templates.accent')}
                data={(['start', 'top', 'bottom'] as const).map((p) => ({
                  value: p,
                  label: t(`templates.accent.${p}`),
                }))}
                value={form.config.accentStrip}
                onChange={(v) => v && setConfig({ accentStrip: v as CardTemplateConfig['accentStrip'] })}
                allowDeselect={false}
              />
              <span />
              <ColorInput
                label={t('templates.background')}
                format="hex"
                value={form.config.background}
                onChange={(v) => /^#[0-9A-Fa-f]{6}$/.test(v) && setConfig({ background: v.toUpperCase() })}
                classNames={{ input: 'ltr mono' }}
              />
              <ColorInput
                label={t('templates.textColor')}
                format="hex"
                value={form.config.textColor}
                onChange={(v) => /^#[0-9A-Fa-f]{6}$/.test(v) && setConfig({ textColor: v.toUpperCase() })}
                classNames={{ input: 'ltr mono' }}
              />
            </SimpleGrid>
            <Switch
              mt="md"
              label={t('templates.isDefault')}
              checked={form.isDefault}
              onChange={(e) => set('isDefault', e.currentTarget.checked)}
            />
          </Card>
          <Group justify="space-between">
            {form.id ? (
              <Button color="breach" variant="subtle" leftSection={<IconTrash size={18} />} onClick={() => void archive()} loading={busy}>
                {t('templates.archive')}
              </Button>
            ) : (
              <span />
            )}
            <Button onClick={() => void save()} loading={busy}>
              {form.id ? t('templates.save') : t('templates.create')}
            </Button>
          </Group>
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 5 }}>
        <Card className="nz-sticky" data-testid="template-preview">
          <Title order={3} fz="md" mb="xs">
            {t('templates.preview')}
          </Title>
          <Text size="xs" c="dimmed" mb="sm">
            {t('templates.previewHint')}
          </Text>
          <CardStyles />
          {preview ? (
            <FitCard template={preview}>
              <WorkCard template={preview} data={SAMPLE_CARD} logoUrl={logoUrl} />
            </FitCard>
          ) : null}
          {size ? (
            <Text size="xs" c="dimmed" mt="sm" ta="center" className="num">
              {t('templates.sizeNote', {
                w: formatNumber(form.orientation === 'PORTRAIT' ? Math.min(size.widthMm, size.heightMm) : Math.max(size.widthMm, size.heightMm)),
                h: formatNumber(form.orientation === 'PORTRAIT' ? Math.max(size.widthMm, size.heightMm) : Math.min(size.widthMm, size.heightMm)),
              })}
            </Text>
          ) : null}
        </Card>
      </Grid.Col>
    </Grid>
  );
}

// ---------------------------------------------------------------- sizes

function SizesPanel() {
  const api = useApi();
  const invalidate = useInvalidateCards();
  const sizes = useCardSizes();
  const [name, setName] = useState('');
  const [w, setW] = useState<number | string>('');
  const [h, setH] = useState<number | string>('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [orientation, setOrientation] = useState<CardOrientation>('LANDSCAPE');

  const add = async () => {
    const input = { name, widthMm: Number(w), heightMm: Number(h) };
    const parsed = cardSizeSchema.safeParse(input);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[i.path.join('.')] ??= t('sizes.invalid');
      setErrors(errs);
      return;
    }
    setErrors({});
    setError(null);
    try {
      await api.cards.createSize(input);
      await invalidate();
      setName('');
      setW('');
      setH('');
      notifications.show({ color: 'ok', message: t('sizes.added') });
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await api.cards.deleteSize(id);
      await invalidate();
    } catch (err) {
      setError(err);
    }
  };

  if (sizes.isLoading) return <LoadingBlock />;
  if (sizes.isError) return <ErrorBlock error={sizes.error} />;

  return (
    <Stack gap="md">
      <Text c="dimmed" size="sm">
        {t('sizes.lead')}
      </Text>
      <FormError error={error} />
      <Card p={0}>
        <Table.ScrollContainer minWidth={520}>
          <Table verticalSpacing="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('sizes.name')}</Table.Th>
                <Table.Th>{t('sizes.dims')}</Table.Th>
                <Table.Th>{t('sizes.kind')}</Table.Th>
                <Table.Th>{t('common.actions')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(sizes.data ?? []).map((s) => (
                <Table.Tr key={s.id}>
                  <Table.Td fw={500}>{s.name}</Table.Td>
                  <Table.Td className="num">
                    <span className="ltr">
                      {formatNumber(s.widthMm)} × {formatNumber(s.heightMm)}
                    </span>{' '}
                    {t('common.mm')}
                  </Table.Td>
                  <Table.Td>
                    {s.isBuiltin ? (
                      <Badge color="slate" variant="outline" leftSection={<IconLock size={12} />}>
                        {t('sizes.builtin')}
                      </Badge>
                    ) : (
                      <Badge color="field" variant="light">
                        {t('sizes.custom')}
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      <Button
                        size="compact-sm"
                        variant="light"
                        leftSection={<IconPrinter size={14} />}
                        component={Link}
                        to={`/cards/calibration?sizeId=${s.id}&orientation=${orientation}`}
                        target="_blank"
                      >
                        {t('sizes.testPrint')}
                      </Button>
                      {s.isBuiltin ? null : (
                        <Tooltip label={t('sizes.delete')}>
                          <ActionIcon
                            color="breach"
                            variant="subtle"
                            aria-label={t('sizes.deleteNamed', { name: s.name })}
                            onClick={() => void remove(s.id)}
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
      <Group gap="xs">
        <Text size="sm">{t('sizes.testOrientation')}</Text>
        <SegmentedControl
          size="xs"
          value={orientation}
          onChange={(v) => setOrientation(v as CardOrientation)}
          data={[
            { value: 'LANDSCAPE', label: t('cards.orientation.LANDSCAPE') },
            { value: 'PORTRAIT', label: t('cards.orientation.PORTRAIT') },
          ]}
        />
      </Group>
      <Card>
        <Title order={3} fz="md" mb="sm">
          {t('sizes.addTitle')}
        </Title>
        <Group align="flex-start" wrap="wrap" gap="sm">
          <TextInput
            label={t('sizes.name')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={errors.name}
            style={{ flex: '2 1 200px' }}
          />
          <NumberInput
            label={t('sizes.width')}
            value={w}
            onChange={setW}
            min={20}
            max={300}
            decimalScale={1}
            error={errors.widthMm}
            style={{ flex: '1 1 110px' }}
          />
          <NumberInput
            label={t('sizes.height')}
            value={h}
            onChange={setH}
            min={15}
            max={300}
            decimalScale={1}
            error={errors.heightMm}
            style={{ flex: '1 1 110px' }}
          />
        </Group>
        <Group justify="flex-end" mt="sm">
          <Button leftSection={<IconPlus size={18} />} onClick={() => void add()}>
            {t('sizes.add')}
          </Button>
        </Group>
      </Card>
    </Stack>
  );
}

// ---------------------------------------------------------------- logos

function LogosPanel() {
  const api = useApi();
  const invalidate = useInvalidateCards();
  const logos = useLogos();
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      await api.logos.upload({ name: name.trim() || file.name.replace(/\.[^.]+$/, ''), file });
      await invalidate();
      setName('');
      notifications.show({ color: 'ok', message: t('logos.uploaded') });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await invalidate();
    } catch (err) {
      setError(err);
    }
  };

  if (logos.isLoading) return <LoadingBlock />;
  if (logos.isError) return <ErrorBlock error={logos.error} />;

  return (
    <Stack gap="md">
      <Text c="dimmed" size="sm">
        {t('logos.lead')}
      </Text>
      <FormError error={error} />
      <Card>
        <Group align="flex-end" wrap="wrap" gap="sm">
          <TextInput
            label={t('logos.name')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            style={{ flex: '1 1 220px' }}
          />
          <FileButton accept="image/png,image/jpeg,image/webp" onChange={(f) => void upload(f)}>
            {(props) => (
              <Button {...props} loading={busy} leftSection={<IconPhotoUp size={18} />}>
                {t('logos.upload')}
              </Button>
            )}
          </FileButton>
        </Group>
        <Text size="xs" c="dimmed" mt="xs">
          {t('logos.types')}
        </Text>
      </Card>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }}>
        {(logos.data ?? []).map((l) => (
          <Card key={l.id}>
            <Box className="nz-logo-box">
              {l.url ? <Image src={l.url} alt={l.name} fit="contain" h={80} /> : null}
            </Box>
            <Group justify="space-between" mt="sm" wrap="nowrap">
              <Text fw={500} truncate>
                {l.name}
              </Text>
              {l.isDefault ? (
                <Badge color="ok" variant="light" leftSection={<IconStar size={12} />}>
                  {t('logos.default')}
                </Badge>
              ) : null}
            </Group>
            <Group gap="xs" mt="sm">
              {!l.isDefault ? (
                <Button size="compact-sm" variant="light" onClick={() => void act(() => api.logos.setDefault(l.id))}>
                  {t('logos.makeDefault')}
                </Button>
              ) : null}
              <Button
                size="compact-sm"
                variant="subtle"
                color="breach"
                onClick={() => void act(() => api.logos.remove(l.id))}
              >
                {t('logos.delete')}
              </Button>
            </Group>
          </Card>
        ))}
      </SimpleGrid>
    </Stack>
  );
}

export function TemplatesPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'templates';
  return (
    <>
      <PageHeader title={t('templates.title')} lead={t('templates.lead')} />
      <Tabs
        value={tab}
        onChange={(v) => setParams(v && v !== 'templates' ? { tab: v } : {}, { replace: true })}
        keepMounted={false}
      >
        <Tabs.List mb="md">
          <Tabs.Tab value="templates">{t('templates.tab.templates')}</Tabs.Tab>
          <Tabs.Tab value="sizes">{t('templates.tab.sizes')}</Tabs.Tab>
          <Tabs.Tab value="logos">{t('templates.tab.logos')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="templates">
          <TemplateEditor />
        </Tabs.Panel>
        <Tabs.Panel value="sizes">
          <SizesPanel />
        </Tabs.Panel>
        <Tabs.Panel value="logos">
          <LogosPanel />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

