/**
 * «استيراد مشروع» — the A9 import wizard (owner decision 3, screenshot 2's «أو» buttons; ADR-117).
 * `/projects/import?source=…&step=…`: 1 the source (Excel, CSV, MS Project XML, MS Project MPP,
 * Jira CSV, Jira Cloud) → 2 the file (drag-drop or picker, type and 20 MB checked, Excel sheet,
 * date order, unit, project name) or the Jira Cloud form (site, e-mail, token — never stored) →
 * 3 the preview (summary, calendar, stats, warnings, a read-only Gantt, «تعيين المسؤولين») → 4 the
 * commit, which opens the new project. Steps are history entries, so the browser's back works.
 * The same screens run on HttpApi and DemoApi; the demo parses in the browser with the API's rules.
 */
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Alert,
  Anchor,
  Button,
  Group,
  List,
  PasswordInput,
  Progress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Stepper,
  Text,
  TextInput,
  Textarea,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBrandTrello,
  IconCloudUpload,
  IconDownload,
  IconFileSpreadsheet,
  IconFileText,
  IconFileTypeCsv,
  IconFileTypeXml,
  IconInfoCircle,
  IconListTree,
  IconLock,
  IconScanEye,
  IconTimeline,
  IconX,
} from '@tabler/icons-react';
import { useMediaQuery } from '@mantine/hooks';
import {
  importJiraSchema,
  type ImportFileFormat,
  type ImportFormat,
  type ImportPreviewDto,
} from '@nuzli/shared';
import { useApi } from '../../../api/context';
import { ApiError } from '../../../api/errors';
import { PageHeader } from '../../../components/ui';
import { blobToArrayBuffer } from '../../../lib/bytes';
import { formatNumber, t, type MessageKey } from '../../../i18n';
import {
  checkImportFile,
  FORMAT_FILE,
  IMPORT_SOURCES,
  MAX_IMPORT_BYTES,
  formatOfName,
  type ImportSource,
} from '../../../features/imports/files';
import { MAX_IMPORT_TASKS } from '../../../features/imports/model';
import { assertJiraSite } from '../../../features/imports/jira';
import {
  importErrorMessage,
  importErrorTitle,
  SOURCE_KEYS,
} from '../../../features/imports/messages';
import { ImportPreview } from './ImportPreview';
import './import.css';

type Unit = 'AUTO' | 'DAY' | 'HOUR';

/** Sample files under `public/samples/` (clearly marked demo data, docs/a9-web-imports.md). */
export const SAMPLES: ReadonlyArray<{
  file: string;
  source: ImportFormat;
  label: MessageKey;
  saveAs: MessageKey;
}> = [
  {
    file: 'nuzli-sample-ar.csv',
    source: 'csv',
    label: 'import.sample.csv',
    saveAs: 'import.sample.csvFile',
  },
  {
    file: 'nuzli-sample.xlsx',
    source: 'xlsx',
    label: 'import.sample.xlsx',
    saveAs: 'import.sample.xlsxFile',
  },
  {
    file: 'nuzli-sample-msproject-hours.xml',
    source: 'xml',
    label: 'import.sample.xml',
    saveAs: 'import.sample.xmlFile',
  },
  {
    file: 'nuzli-sample-jira.csv',
    source: 'jira-csv',
    label: 'import.sample.jira',
    saveAs: 'import.sample.jiraFile',
  },
];

const sampleUrl = (file: string) =>
  `${(import.meta.env.BASE_URL as string | undefined) ?? '/'}samples/${file}`;

const STEP_LABELS: MessageKey[] = [
  'import.step.source',
  'import.step.file',
  'import.step.preview',
  'import.step.create',
];

const SOURCE_ICON: Record<ImportSource, typeof IconFileText> = {
  ganttpro: IconTimeline,
  xlsx: IconFileSpreadsheet,
  csv: IconFileTypeCsv,
  xml: IconFileTypeXml,
  mpp: IconFileText,
  'jira-csv': IconBrandTrello,
  'jira-cloud': IconBrandTrello,
};

/** A Latin token (`.csv`) isolated left-to-right inside Arabic text (no «(csv.)»). */
const ltr = (s: string) => `⁦${s}⁩`;

const isSource = (v: string | null): v is ImportSource =>
  !!v && (IMPORT_SOURCES as readonly string[]).includes(v);

const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024
    ? t('import.file.mb', { n: formatNumber(Math.round((bytes / 1024 / 1024) * 10) / 10) })
    : t('import.file.kb', { n: formatNumber(Math.max(1, Math.round(bytes / 1024))) });

export function ImportWizardPage() {
  const api = useApi();
  const location = useLocation();
  const navigate = useNavigate();
  const phone = useMediaQuery('(max-width: 600px)') ?? false;
  const params = new URLSearchParams(location.search);
  const rawSource = params.get('source');
  const source: ImportSource | null = isSource(rawSource) ? rawSource : null;
  const rawStep = Number(params.get('step'));
  const [preview, setPreview] = useState<ImportPreviewDto | null>(null);
  const [committing, setCommitting] = useState(false);
  // Without a source there is no step 2; without a preview no step 3 (a reload starts again).
  const step = !source ? 0 : rawStep === 3 && preview ? 2 : 1;

  const go = (next: { source?: ImportSource | null; step: number }, replace = false) => {
    const sp = new URLSearchParams();
    const s = next.source === undefined ? source : next.source;
    if (s) sp.set('source', s);
    if (next.step > 1) sp.set('step', String(next.step));
    navigate(
      { pathname: location.pathname, search: sp.toString() ? `?${sp}` : '' },
      { replace, state: { nzStep: next.step } },
    );
  };

  // A step URL that cannot be shown (reload on the preview) is replaced by the one that can.
  useEffect(() => {
    if (rawStep === 3 && !preview && source) go({ step: 2 }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawStep, preview, source]);

  const [file, setFile] = useState<File | null>(null);

  const chooseSource = (s: ImportSource, f: File | null = null) => {
    setFile(f);
    setPreview(null);
    go({ source: s, step: 2 });
  };

  const trySample = async (sample: (typeof SAMPLES)[number]) => {
    const res = await fetch(sampleUrl(sample.file));
    const blob = await res.blob();
    // The file keeps an Arabic name, which becomes the default project name when the file has no title.
    chooseSource(
      sample.source,
      new File([blob], t(sample.saveAs), { type: FORMAT_FILE[sample.source].contentType }),
    );
  };

  return (
    <div className="nz-imp">
      <PageHeader
        title={t('import.title')}
        lead={t('import.lead')}
        actions={
          <Button
            component={Link}
            to="/projects"
            variant="default"
            leftSection={<IconArrowRight size={16} className="mirror-rtl" />}
          >
            {t('import.backToProjects')}
          </Button>
        }
      />
      {phone ? (
        <Text size="sm" fw={600} mb="md" className="nz-imp-step-phone" aria-live="polite">
          {t('import.step.of', {
            n: (committing ? 3 : step) + 1,
            total: 4,
            label: t(STEP_LABELS[committing ? 3 : step]!),
          })}
        </Text>
      ) : (
        <Stepper
          active={committing ? 3 : step}
          size="sm"
          mb="lg"
          className="nz-imp-stepper"
          allowNextStepsSelect={false}
        >
          <Stepper.Step label={t('import.step.source')} />
          <Stepper.Step label={t('import.step.file')} />
          <Stepper.Step label={t('import.step.preview')} />
          <Stepper.Step label={t('import.step.create')} />
        </Stepper>
      )}

      {step === 0 ? (
        <SourceStep
          onChoose={chooseSource}
          onSample={(s) => void trySample(s)}
          demo={api.mode === 'demo'}
        />
      ) : null}
      {step === 1 && source ? (
        source === 'jira-cloud' ? (
          <JiraStep
            onBack={() => go({ source: null, step: 1 })}
            onUseCsv={() => chooseSource('jira-csv')}
            onPreview={(pv) => {
              setPreview(pv);
              go({ step: 3 });
            }}
          />
        ) : (
          <FileStep
            key={source}
            format={source}
            file={file}
            onFile={setFile}
            onSwitch={(s, f) => chooseSource(s, f)}
            onBack={() => go({ source: null, step: 1 })}
            onUseXml={() => chooseSource('xml')}
            onPreview={(pv) => {
              setPreview(pv);
              go({ step: 3 });
            }}
          />
        )
      ) : null}
      {step === 2 && preview ? (
        <ImportPreview
          preview={preview}
          fileName={source !== 'jira-cloud' ? file?.name : undefined}
          onBack={() => go({ step: 2 })}
          onCommitting={setCommitting}
          onExpired={() => {
            setPreview(null);
            go({ step: 2 }, true);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- step 1: source

function SourceStep({
  onChoose,
  onSample,
  demo,
}: {
  onChoose(s: ImportSource): void;
  onSample(s: (typeof SAMPLES)[number]): void;
  demo: boolean;
}) {
  const card = (src: ImportSource) => {
    const Icon = SOURCE_ICON[src];
    const serverOnly = demo && (src === 'mpp' || src === 'jira-cloud');
    return (
      <div key={src} role="listitem" className="nz-imp-source-item">
        <UnstyledButton
          className="nz-imp-source surface-card"
          onClick={() => onChoose(src)}
          data-source={src}
        >
          <span className="nz-imp-source-icon" aria-hidden>
            <Icon size={22} />
          </span>
          <span className="nz-imp-source-body">
            <span className="nz-imp-source-title">{t(SOURCE_KEYS[src]!.title)}</span>
            <span className="nz-imp-source-hint">{t(SOURCE_KEYS[src]!.hint)}</span>
            {serverOnly ? (
              <span className="pill wait nz-imp-source-pill">
                {t('import.source.needsServer')}
              </span>
            ) : null}
          </span>
        </UnstyledButton>
      </div>
    );
  };
  return (
    <Stack gap="lg">
      {/* A10: ready projects from GanttPRO and Microsoft Project come first. */}
      <section className="nz-imp-ready" aria-labelledby="imp-ready">
        <Text id="imp-ready" fw={700} className="nz-imp-section-title">
          {t('import.source.readyTitle')}
        </Text>
        <Text size="sm" c="dimmed" mb="sm">
          {t('import.source.readyLead')}
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" role="list">
          <div role="listitem" className="nz-imp-source-item">
            <UnstyledButton
              className="nz-imp-source nz-imp-featured surface-card"
              onClick={() => onChoose('ganttpro')}
              data-source="ganttpro"
            >
              <span className="nz-imp-source-icon nz-imp-featured-icon" aria-hidden>
                <IconTimeline size={26} />
              </span>
              <span className="nz-imp-source-body">
                <span className="nz-imp-source-title">{t('import.source.ganttpro')}</span>
                <span className="nz-imp-source-hint">{t('import.source.ganttproHint')}</span>
                <span className="nz-imp-how" dir="rtl">
                  {t('import.source.ganttproHow')}
                </span>
              </span>
            </UnstyledButton>
          </div>
          <div role="listitem" className="nz-imp-source-item">
            <div className="nz-imp-source nz-imp-featured surface-card" data-source="msproject">
              <span className="nz-imp-source-icon nz-imp-featured-icon" aria-hidden>
                <IconListTree size={26} />
              </span>
              <span className="nz-imp-source-body">
                <span className="nz-imp-source-title">{t('import.source.msproject')}</span>
                <span className="nz-imp-source-hint">{t('import.source.msprojectHint')}</span>
                <span className="nz-imp-how" dir="rtl">
                  {t('import.source.msprojectHow')}
                </span>
                <Group gap={8} mt={6} wrap="wrap">
                  <Button
                    size="xs"
                    leftSection={<IconFileTypeXml size={16} />}
                    onClick={() => onChoose('xml')}
                    data-source="xml"
                    aria-label={`${t('import.source.xml')} — ${t('import.source.xmlHint')}`}
                  >
                    {t('import.source.xmlButton')}
                  </Button>
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={<IconFileText size={16} />}
                    onClick={() => onChoose('mpp')}
                    data-source="mpp"
                    aria-label={`${t('import.source.mpp')} — ${t('import.source.mppHint')}`}
                    rightSection={
                      demo ? (
                        <span className="pill wait nz-imp-source-pill">
                          {t('import.source.needsServer')}
                        </span>
                      ) : undefined
                    }
                  >
                    {t('import.source.mppButton')}
                  </Button>
                </Group>
              </span>
            </div>
          </div>
        </SimpleGrid>
      </section>
      <section aria-labelledby="imp-table">
        <Text id="imp-table" fw={700} className="nz-imp-section-title" mb="sm">
          {t('import.source.tableTitle')}
        </Text>
        <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="md" role="list">
          {(['xlsx', 'csv', 'jira-csv', 'jira-cloud'] as const).map(card)}
        </SimpleGrid>
      </section>
      <div className="nz-imp-samples surface-card">
        <Text fw={600} mb={4}>
          {t('import.sample.title')}
        </Text>
        <Text size="sm" c="dimmed" mb="sm">
          {t('import.sample.lead')}
        </Text>
        <div className="nz-imp-sample-list">
          {SAMPLES.map((s) => (
            <div key={s.file} className="nz-imp-sample">
              <Text size="sm" fw={500} className="nz-imp-sample-name">
                {t(s.label)}
              </Text>
              <Group gap={6} wrap="nowrap">
                <Button size="compact-sm" variant="light" onClick={() => onSample(s)}>
                  {t('import.sample.try')}
                </Button>
                <Anchor
                  href={sampleUrl(s.file)}
                  download={t(s.saveAs)}
                  size="sm"
                  className="nz-imp-sample-dl"
                  aria-label={t('import.sample.download', { name: t(s.label) })}
                >
                  <IconDownload size={16} />
                </Anchor>
              </Group>
            </div>
          ))}
        </div>
        <Text size="xs" c="dimmed" mt="sm">
          {t('import.sample.note')}
        </Text>
      </div>
    </Stack>
  );
}

// ---------------------------------------------------------------- step 2: file

function FileStep({
  format,
  file,
  onFile,
  onSwitch,
  onBack,
  onUseXml,
  onPreview,
}: {
  format: ImportFileFormat;
  file: File | null;
  onFile(f: File | null): void;
  /** A10: MS Project XML ↔ .mpp follow the picked file's extension. */
  onSwitch(source: ImportFileFormat, f: File): void;
  onBack(): void;
  onUseXml(): void;
  onPreview(pv: ImportPreviewDto): void;
}) {
  const api = useApi();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState<string | null>(null);
  const [dateOrder, setDateOrder] = useState<'DMY' | 'MDY'>('DMY');
  const [unit, setUnit] = useState<Unit>('AUTO');
  const [projectName, setProjectName] = useState('');
  const [busy, setBusy] = useState<null | 'upload' | 'parse'>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const problem = file ? checkImportFile(file, format) : null;
  const tabular = format === 'xlsx' || format === 'csv' || format === 'jira-csv';
  const workbook = format === 'xlsx' || format === 'ganttpro';
  const [isGanttpro, setIsGanttpro] = useState(false);

  // Excel: the sheet names and whether it is a GanttPRO export (read in the browser; the server
  // reads the chosen sheet and decides the format from the content again).
  useEffect(() => {
    setSheets([]);
    setSheet(null);
    setIsGanttpro(false);
    if (!file || !workbook || problem) return;
    let live = true;
    void (async () => {
      try {
        const { xlsxSummary } = await import('../../../features/imports/tabular');
        const info = await xlsxSummary(new Uint8Array(await blobToArrayBuffer(file)));
        if (live) {
          setSheets(info.sheets);
          setIsGanttpro(info.ganttpro);
        }
      } catch (err) {
        if (live) setError(err);
      }
    })();
    return () => {
      live = false;
    };
  }, [file, workbook, problem]);

  const pick = (f: File | undefined | null) => {
    setError(null);
    if (!f) return;
    // A10: «Microsoft Project (XML / MPP)» is one source — the extension picks the reader.
    const guessed = formatOfName(f.name);
    if ((format === 'xml' || format === 'mpp') && (guessed === 'xml' || guessed === 'mpp') && guessed !== format) {
      onSwitch(guessed, f);
      return;
    }
    onFile(f);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    pick(e.dataTransfer.files?.[0]);
  };

  const submit = async () => {
    if (!file || problem) return;
    setError(null);
    setBusy('upload');
    setProgress(0);
    try {
      const { fileId } = await api.imports.upload(file, FORMAT_FILE[format].contentType, {
        onProgress: setProgress,
      });
      setBusy('parse');
      const pv = await api.imports.preview({
        fileId,
        format,
        options: {
          dateOrder,
          ...(sheet ? { sheetName: sheet } : {}),
          ...(unit !== 'AUTO' ? { durationUnit: unit } : {}),
          ...(projectName.trim().length >= 2 ? { projectName: projectName.trim() } : {}),
        },
      });
      onPreview(pv);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const mppError =
    error instanceof ApiError &&
    (error.code === 'MPP_CONVERTER_NOT_CONFIGURED' || error.code === 'MPP_CONVERSION_FAILED');
  const accept = workbook
    ? `${FORMAT_FILE.xlsx.ext},${FORMAT_FILE.xlsx.contentType}`
    : format === 'xml' || format === 'mpp'
      ? '.xml,.mpp'
      : FORMAT_FILE[format].ext;

  return (
    <Stack gap="md" className="nz-imp-panel">
      <Text fw={600}>{t('import.file.title', { source: t(SOURCE_KEYS[format]!.title) })}</Text>
      {format === 'ganttpro' || format === 'xml' ? <HowTo format={format} /> : null}
      {format === 'mpp' && api.mode === 'demo' ? <MppHelp tone="info" onUseXml={onUseXml} /> : null}
      <div
        className="nz-imp-drop"
        data-drag={drag || undefined}
        data-has-file={file ? true : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        <IconCloudUpload size={30} className="nz-imp-drop-icon" aria-hidden />
        <Text fw={500}>{t('import.file.drop', { ext: ltr(FORMAT_FILE[format].ext) })}</Text>
        <Text size="xs" c="dimmed">
          {t('import.file.limit', {
            mb: formatNumber(MAX_IMPORT_BYTES / 1024 / 1024),
            max: formatNumber(MAX_IMPORT_TASKS),
          })}
        </Text>
        <Button variant="light" size="sm" onClick={() => input.current?.click()}>
          {t('import.file.pick')}
        </Button>
        <input
          ref={input}
          type="file"
          accept={accept}
          hidden
          aria-label={t('import.file.pick')}
          data-testid="import-file-input"
          onChange={(e) => {
            pick(e.currentTarget.files?.[0]);
            e.currentTarget.value = '';
          }}
        />
      </div>
      {file ? (
        <div className="nz-imp-file" data-invalid={problem ? true : undefined}>
          <IconFileText size={18} aria-hidden />
          <span className="nz-imp-file-name" dir="auto">
            {file.name}
          </span>
          <span className="nz-imp-file-size num">{sizeLabel(file.size)}</span>
          <UnstyledButton
            className="nz-imp-file-x"
            aria-label={t('import.file.remove')}
            onClick={() => onFile(null)}
          >
            <IconX size={14} />
          </UnstyledButton>
        </div>
      ) : null}
      {file && isGanttpro && !problem ? (
        <Alert
          color="ok"
          variant="light"
          icon={<IconScanEye size={18} />}
          title={t('import.detected.ganttpro')}
          data-testid="import-detected-file"
        >
          <Text size="sm">{t('import.detected.fileStep')}</Text>
        </Alert>
      ) : null}
      {problem ? (
        <Alert color="breach" icon={<IconAlertTriangle size={18} />} role="alert">
          {problem === 'type'
            ? t('import.file.badType', {
                ext: ltr(FORMAT_FILE[format].ext),
                suggestion: suggestion(file!.name, format),
              })
            : problem === 'size'
              ? t('import.err.size')
              : t('import.file.empty')}
        </Alert>
      ) : null}

      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        {workbook && sheets.length > 1 ? (
          <Select
            label={t('import.opt.sheet')}
            description={t('import.opt.sheetHint')}
            placeholder={t('import.opt.sheetAuto')}
            data={sheets}
            value={sheet}
            onChange={setSheet}
            clearable
          />
        ) : null}
        {tabular ? (
          <div>
            <Text size="sm" fw={500} mb={4} id="imp-order">
              {t('import.opt.dateOrder')}
            </Text>
            <SegmentedControl
              aria-labelledby="imp-order"
              fullWidth
              value={dateOrder}
              onChange={(v) => setDateOrder(v as 'DMY' | 'MDY')}
              data={[
                { value: 'DMY', label: t('import.opt.DMY') },
                { value: 'MDY', label: t('import.opt.MDY') },
              ]}
            />
          </div>
        ) : null}
        <UnitSelect value={unit} onChange={setUnit} />
        <TextInput
          label={t('import.opt.projectName')}
          description={t('import.opt.projectNameHint')}
          value={projectName}
          onChange={(e) => setProjectName(e.currentTarget.value)}
          maxLength={160}
        />
      </SimpleGrid>

      {busy ? (
        <div aria-live="polite">
          <Text size="sm" mb={4}>
            {busy === 'upload' ? t('import.file.uploading') : t('import.file.parsing')}
          </Text>
          <Progress
            value={busy === 'upload' ? Math.round(progress * 100) : 100}
            animated={busy === 'parse'}
          />
        </div>
      ) : null}
      {error ? (
        mppError ? (
          <MppHelp tone="error" error={error} onUseXml={onUseXml} />
        ) : (
          <ImportErrorAlert error={error} />
        )
      ) : null}

      <Group justify="space-between">
        <Button variant="default" onClick={onBack} disabled={!!busy}>
          {t('import.backToSources')}
        </Button>
        <Button onClick={() => void submit()} disabled={!file || !!problem} loading={!!busy}>
          {t('import.file.submit')}
        </Button>
      </Group>
    </Stack>
  );
}

/** A10: how to get the file out of GanttPRO / MS Project (text and icons only, no third-party logos). */
function HowTo({ format }: { format: 'ganttpro' | 'xml' }) {
  const k = format === 'ganttpro' ? 'ganttpro' : 'msproject';
  return (
    <Alert color="signal" variant="light" icon={<IconInfoCircle size={18} />} title={t('import.how.title')}>
      <List size="sm" type="ordered" spacing={2}>
        <List.Item>{t(`import.how.${k}.1` as MessageKey)}</List.Item>
        <List.Item>{t(`import.how.${k}.2` as MessageKey)}</List.Item>
        <List.Item>{t(`import.how.${k}.3` as MessageKey)}</List.Item>
      </List>
    </Alert>
  );
}

function suggestion(name: string, format: ImportFileFormat): string {
  const guessed = formatOfName(name);
  if (!guessed || guessed === format) return '';
  return t('import.file.suggest', { source: t(SOURCE_KEYS[guessed]!.title) });
}

function UnitSelect({ value, onChange }: { value: Unit; onChange(u: Unit): void }) {
  return (
    <Select
      label={t('import.opt.unit')}
      description={t('import.opt.unitHint')}
      data={[
        { value: 'AUTO', label: t('import.opt.unitAuto') },
        { value: 'DAY', label: t('createProject.unit.DAY') },
        { value: 'HOUR', label: t('createProject.unit.HOUR') },
      ]}
      value={value}
      onChange={(v) => onChange((v as Unit) ?? 'AUTO')}
      allowDeselect={false}
    />
  );
}

/** «.mpp» needs the converter next to the API (ADR-111): the way out is MS Project → Save as XML. */
function MppHelp({
  tone,
  error,
  onUseXml,
}: {
  tone: 'info' | 'error';
  error?: unknown;
  onUseXml(): void;
}) {
  return (
    <Alert
      color={tone === 'error' ? 'breach' : 'signal'}
      icon={<IconInfoCircle size={18} />}
      title={t('import.mpp.needsServer')}
      role={tone === 'error' ? 'alert' : undefined}
    >
      <Stack gap={6}>
        {error ? (
          <Text size="sm">{importErrorMessage(error)}</Text>
        ) : (
          <Text size="sm">{t('import.mpp.demoBody')}</Text>
        )}
        <List size="sm" type="ordered" spacing={2}>
          <List.Item>{t('import.mpp.step1')}</List.Item>
          <List.Item>{t('import.mpp.step2')}</List.Item>
          <List.Item>{t('import.mpp.step3')}</List.Item>
        </List>
        <Button size="xs" variant="light" onClick={onUseXml} style={{ alignSelf: 'flex-start' }}>
          {t('import.mpp.useXml')}
        </Button>
      </Stack>
    </Alert>
  );
}

export function ImportErrorAlert({ error, children }: { error: unknown; children?: ReactNode }) {
  return (
    <Alert
      color="breach"
      icon={<IconAlertTriangle size={18} />}
      title={importErrorTitle(error) ?? undefined}
      role="alert"
    >
      <Stack gap={6}>
        <Text size="sm">{importErrorMessage(error)}</Text>
        {children}
      </Stack>
    </Alert>
  );
}

// ---------------------------------------------------------------- step 2: Jira Cloud

type JiraField = 'siteUrl' | 'email' | 'apiToken' | 'projectKey' | 'jql';

/** Instant Arabic messages for the Jira form (the API checks everything again). */
export function jiraFieldErrors(v: {
  siteUrl: string;
  email: string;
  apiToken: string;
  mode: 'key' | 'jql';
  projectKey: string;
  jql: string;
}): Partial<Record<JiraField, string>> {
  const out: Partial<Record<JiraField, string>> = {};
  const r = importJiraSchema.safeParse({
    siteUrl: v.siteUrl,
    email: v.email,
    apiToken: v.apiToken,
    ...(v.mode === 'key'
      ? { projectKey: v.projectKey.trim().toUpperCase() || undefined }
      : { jql: v.jql.trim() || undefined }),
  });
  if (!r.success) {
    for (const issue of r.error.issues) {
      const k = issue.path[0] as JiraField | undefined;
      if (k && !out[k])
        out[k] =
          k === 'projectKey' && v.mode === 'jql' ? t('import.jira.jqlRequired') : issue.message;
    }
  }
  if (!out.siteUrl) {
    try {
      assertJiraSite(v.siteUrl.trim());
    } catch {
      out.siteUrl = t('import.jira.siteRule');
    }
  }
  if (!v.siteUrl.trim()) out.siteUrl = t('common.required');
  return out;
}

function JiraStep({
  onBack,
  onUseCsv,
  onPreview,
}: {
  onBack(): void;
  onUseCsv(): void;
  onPreview(pv: ImportPreviewDto): void;
}) {
  const api = useApi();
  const demo = api.mode === 'demo';
  const [siteUrl, setSiteUrl] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [mode, setMode] = useState<'key' | 'jql'>('key');
  const [projectKey, setProjectKey] = useState('');
  const [jql, setJql] = useState('');
  const [unit, setUnit] = useState<Unit>('AUTO');
  const [projectName, setProjectName] = useState('');
  const [errors, setErrors] = useState<Partial<Record<JiraField, string>>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // The token lives only in this component's state and is cleared on leave.
  useEffect(() => () => setApiToken(''), []);

  const submit = async () => {
    const next = jiraFieldErrors({ siteUrl, email, apiToken, mode, projectKey, jql });
    setErrors(next);
    if (Object.keys(next).length) return;
    setError(null);
    setBusy(true);
    try {
      const pv = await api.imports.jira({
        siteUrl: siteUrl.trim(),
        email: email.trim(),
        apiToken,
        ...(mode === 'key' ? { projectKey: projectKey.trim().toUpperCase() } : { jql: jql.trim() }),
        options: {
          ...(unit !== 'AUTO' ? { durationUnit: unit } : {}),
          ...(projectName.trim().length >= 2 ? { projectName: projectName.trim() } : {}),
        },
      });
      setApiToken('');
      onPreview(pv);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length)
        setErrors(err.fieldErrors as Partial<Record<JiraField, string>>);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const demoError =
    error instanceof ApiError &&
    error.code === 'JIRA_REQUEST_FAILED' &&
    (error.details as { reason?: string } | undefined)?.reason === 'demo';

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
      autoComplete="off"
    >
      <Stack gap="md" className="nz-imp-panel">
        <Text fw={600}>{t('import.jira.title')}</Text>
        {demo ? (
          <Alert
            color="signal"
            icon={<IconInfoCircle size={18} />}
            title={t('import.jira.demoTitle')}
          >
            <Stack gap={6}>
              <Text size="sm">{t('import.jira.demoBody')}</Text>
              <Button
                size="xs"
                variant="light"
                onClick={onUseCsv}
                style={{ alignSelf: 'flex-start' }}
              >
                {t('import.jira.useCsv')}
              </Button>
            </Stack>
          </Alert>
        ) : null}
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
          <TextInput
            label={t('import.jira.site')}
            description={t('import.jira.siteHint')}
            placeholder={t('import.jira.sitePlaceholder')}
            dir="ltr"
            required
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.currentTarget.value)}
            error={errors.siteUrl}
            inputMode="url"
          />
          <TextInput
            label={t('import.jira.email')}
            dir="ltr"
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            error={errors.email}
            autoComplete="off"
          />
          <PasswordInput
            label={t('import.jira.token')}
            description={t('import.jira.tokenHint')}
            dir="ltr"
            required
            value={apiToken}
            onChange={(e) => setApiToken(e.currentTarget.value)}
            error={errors.apiToken}
            autoComplete="new-password"
            leftSection={<IconLock size={16} />}
          />
          <div>
            <Text size="sm" fw={500} mb={4} id="imp-jira-mode">
              {t('import.jira.scope')}
            </Text>
            <SegmentedControl
              aria-labelledby="imp-jira-mode"
              fullWidth
              value={mode}
              onChange={(v) => setMode(v as 'key' | 'jql')}
              data={[
                { value: 'key', label: t('import.jira.byKey') },
                { value: 'jql', label: t('import.jira.byJql') },
              ]}
            />
          </div>
          {mode === 'key' ? (
            <TextInput
              label={t('import.jira.projectKey')}
              placeholder={t('import.jira.projectKeyPlaceholder')}
              dir="ltr"
              value={projectKey}
              onChange={(e) => setProjectKey(e.currentTarget.value)}
              error={errors.projectKey}
            />
          ) : (
            <Textarea
              label={t('import.jira.jql')}
              placeholder={t('import.jira.jqlPlaceholder')}
              dir="ltr"
              autosize
              minRows={2}
              value={jql}
              onChange={(e) => setJql(e.currentTarget.value)}
              error={errors.jql ?? errors.projectKey}
            />
          )}
          <UnitSelect value={unit} onChange={setUnit} />
          <TextInput
            label={t('import.opt.projectName')}
            description={t('import.opt.projectNameHint')}
            value={projectName}
            onChange={(e) => setProjectName(e.currentTarget.value)}
            maxLength={160}
          />
        </SimpleGrid>
        <Alert color="gray" variant="light" icon={<IconLock size={18} />}>
          <Text size="sm">{t('import.jira.tokenWarning')}</Text>
        </Alert>
        {error ? (
          <ImportErrorAlert error={error}>
            {demoError ? (
              <Button
                size="xs"
                variant="light"
                onClick={onUseCsv}
                style={{ alignSelf: 'flex-start' }}
              >
                {t('import.jira.useCsv')}
              </Button>
            ) : null}
          </ImportErrorAlert>
        ) : null}
        <Group justify="space-between">
          <Button variant="default" onClick={onBack} disabled={busy}>
            {t('import.backToSources')}
          </Button>
          <Button type="submit" loading={busy}>
            {t('import.jira.submit')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export default ImportWizardPage;
