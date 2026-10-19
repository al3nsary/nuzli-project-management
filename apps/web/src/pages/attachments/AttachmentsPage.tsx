import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ActionIcon, Button, Loader, Modal, SegmentedControl, Select, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedValue, useInViewport } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  IconArrowLeft,
  IconArrowRight,
  IconExternalLink,
  IconFile,
  IconFileTypePdf,
  IconFolder,
  IconLayoutGrid,
  IconList,
  IconPaperclip,
  IconPhoto,
  IconSearch,
} from '@tabler/icons-react';
import { ATTACHMENT_TYPES, can, type AttachmentBrowseDto, type AttachmentKindGroup } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { useProjects } from '../../api/projectQueries';
import { useViewPref } from '../../api/a9Queries';
import { useAuthStore } from '../../stores/auth';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../../components/ui';
import { formatDate, formatDateTime, formatNumber, t, type MessageKey } from '../../i18n';
import { dirSign } from '../../lib/direction';
import './attachments.css';

const PAGE = 48;

/** «١٫٢ م.ب» / «٣٤٠ ك.ب». */
export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return t('att.sizeMb', { n: formatNumber(Math.round((bytes / (1024 * 1024)) * 10) / 10) });
  return t('att.sizeKb', { n: formatNumber(Math.max(1, Math.round(bytes / 1024))) });
}

const TYPE_ICON = { image: IconPhoto, pdf: IconFileTypePdf, other: IconFile } as const;

/** Signed URL of one attachment, fetched when it scrolls into view (images only). */
function useFileUrl(file: AttachmentBrowseDto | undefined, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['attachments', 'url', file?.id ?? ''],
    queryFn: () => api.tasks.attachmentUrl(file!.task.id, file!.id),
    enabled: enabled && Boolean(file),
    staleTime: 60_000,
    retry: false,
  });
}

function Thumb({ file, size = 'card' }: { file: AttachmentBrowseDto; size?: 'card' | 'row' }) {
  const { ref, inViewport } = useInViewport();
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (inViewport) setSeen(true);
  }, [inViewport]);
  const isImg = file.type === 'image';
  const url = useFileUrl(file, isImg && seen);
  const Icon = TYPE_ICON[file.type];
  return (
    <span ref={ref} className="at-thumb" data-size={size} data-type={file.type}>
      {isImg && url.data ? (
        <img src={url.data.url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false} />
      ) : isImg && url.isLoading && seen ? (
        <Loader size="xs" />
      ) : (
        <Icon size={size === 'card' ? 34 : 20} stroke={1.5} aria-hidden />
      )}
    </span>
  );
}

function useAttachmentParams() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const type = params.get('type');
  return {
    projectId: params.get('project') ?? '',
    type: (ATTACHMENT_TYPES as readonly string[]).includes(type ?? '') ? (type as AttachmentKindGroup) : null,
    uploadedBy: params.get('by') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    q: params.get('q') ?? '',
    set(patch: Record<string, string | null>) {
      const next = new URLSearchParams(location.search);
      for (const [k, v] of Object.entries(patch)) {
        if (!v) next.delete(k);
        else next.set(k, v);
      }
      const s = next.toString();
      navigate({ pathname: location.pathname, search: s ? `?${s}` : '' }, { replace: true, preventScrollReset: true });
    },
  };
}

/**
 * «المرفقات» (route `/attachments`, owner request A9): every file attached to the tasks the viewer
 * can open — admins all, supervisors only their own tasks' (the API scopes it). Grid or list
 * (remembered per user), filters (project, type, uploader, date range) and a search on the task
 * or project name; image thumbnails through short-lived signed URLs fetched with no referrer;
 * a lightbox for images (arrows to browse), PDFs and other files in a new tab; a jump to the task.
 */
export function AttachmentsPage() {
  const api = useApi();
  const user = useAuthStore((s) => s.user);
  const isAdmin = can(user, 'projects.readAll');
  const p = useAttachmentParams();
  const [search, setSearch] = useState(p.q);
  const [debounced] = useDebouncedValue(search.trim(), 300);
  const [size, setSize] = useState(PAGE);
  const [view, setView] = useViewPref<'grid' | 'list'>('attachments.view', null, 'grid');
  const [preview, setPreview] = useState<number | null>(null);

  useEffect(() => {
    if (debounced !== p.q) p.set({ q: debounced || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  useEffect(() => setSize(PAGE), [p.projectId, p.type, p.uploadedBy, p.from, p.to, p.q]);

  const query = {
    projectId: p.projectId || undefined,
    type: p.type ?? undefined,
    uploadedBy: p.uploadedBy || undefined,
    from: p.from || undefined,
    to: p.to || undefined,
    q: p.q || undefined,
  };
  const list = useQuery({
    queryKey: ['attachments', 'browse', query, size],
    queryFn: () => api.hub.attachments({ ...query, pageSize: Math.min(100, size) }),
    placeholderData: keepPreviousData,
  });
  // Filter choices from the viewer's own scope (supervisors cannot list projects or users).
  const scope = useQuery({
    queryKey: ['attachments', 'scope'],
    queryFn: () => api.hub.attachments({ pageSize: 100 }),
    staleTime: 60_000,
  });
  const projects = useProjects({}, isAdmin);
  const projectOptions = useMemo(() => {
    if (isAdmin && projects.data) return projects.data.map((pr) => ({ value: pr.id, label: pr.name }));
    const m = new Map<string, string>();
    for (const f of scope.data?.items ?? []) m.set(f.project.id, f.project.name);
    return [...m].map(([value, label]) => ({ value, label }));
  }, [isAdmin, projects.data, scope.data]);
  const uploaderOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of scope.data?.items ?? []) if (f.uploadedBy) m.set(f.uploadedBy.id, f.uploadedBy.fullName);
    return [...m].map(([value, label]) => ({ value, label }));
  }, [scope.data]);

  const items = list.data?.items ?? [];
  const images = items.filter((f) => f.type === 'image');
  const filtered = Boolean(p.projectId || p.type || p.uploadedBy || p.from || p.to || p.q);

  const taskLink = (f: AttachmentBrowseDto) =>
    isAdmin
      ? `/projects/${encodeURIComponent(f.project.id)}?task=${encodeURIComponent(f.task.id)}&ttab=files`
      : `/my-tasks/${encodeURIComponent(f.task.id)}`;

  const openFile = async (f: AttachmentBrowseDto) => {
    if (f.type === 'image') {
      setPreview(images.findIndex((x) => x.id === f.id));
      return;
    }
    try {
      const { url } = await api.tasks.attachmentUrl(f.task.id, f.id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      notifications.show({ color: 'breach', message: errorMessage(err) });
    }
  };

  return (
    <>
      <PageHeader
        title={t('nav.attachments')}
        lead={isAdmin ? t('att.leadAdmin') : t('att.leadSupervisor')}
        actions={
          <SegmentedControl
            aria-label={t('att.view')}
            value={view}
            onChange={(v) => setView(v as 'grid' | 'list')}
            data={[
              { value: 'grid', label: <span className="at-seg"><IconLayoutGrid size={16} aria-hidden />{t('att.grid')}</span> },
              { value: 'list', label: <span className="at-seg"><IconList size={16} aria-hidden />{t('att.list')}</span> },
            ]}
          />
        }
      />
      <div className="at-filters">
        <TextInput
          aria-label={t('att.search')}
          placeholder={t('att.search')}
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          className="at-f-search"
        />
        <Select
          aria-label={t('att.project')}
          placeholder={t('att.allProjects')}
          data={projectOptions}
          value={p.projectId || null}
          onChange={(v) => p.set({ project: v })}
          clearable
          searchable
          leftSection={<IconFolder size={16} />}
          className="at-f-project"
        />
        <SegmentedControl
          aria-label={t('att.type')}
          value={p.type ?? 'all'}
          onChange={(v) => p.set({ type: v === 'all' ? null : v })}
          data={[
            { value: 'all', label: t('att.type.all') },
            ...ATTACHMENT_TYPES.map((ty) => ({ value: ty, label: t(`att.type.${ty}` as MessageKey) })),
          ]}
          className="at-f-type"
        />
        <Select
          aria-label={t('att.uploadedBy')}
          placeholder={t('att.anyUploader')}
          data={uploaderOptions}
          value={p.uploadedBy || null}
          onChange={(v) => p.set({ by: v })}
          clearable
          searchable
          className="at-f-by"
        />
        <TextInput
          type="date"
          aria-label={t('att.from')}
          title={t('att.from')}
          value={p.from}
          leftSection={<span className="at-date-tag">{t('att.fromShort')}</span>}
          leftSectionWidth={44}
          max={p.to || undefined}
          onChange={(e) => p.set({ from: e.currentTarget.value || null })}
          classNames={{ input: 'num' }}
          className="at-f-date"
        />
        <TextInput
          type="date"
          aria-label={t('att.to')}
          title={t('att.to')}
          value={p.to}
          leftSection={<span className="at-date-tag">{t('att.toShort')}</span>}
          leftSectionWidth={44}
          min={p.from || undefined}
          onChange={(e) => p.set({ to: e.currentTarget.value || null })}
          classNames={{ input: 'num' }}
          className="at-f-date"
        />
      </div>

      {list.isLoading ? (
        <LoadingBlock variant={view === 'grid' ? 'cards' : 'table'} rows={8} />
      ) : list.isError ? (
        <ErrorBlock error={list.error} onRetry={() => void list.refetch()} />
      ) : !items.length ? (
        <EmptyState
          icon={IconPaperclip}
          title={filtered ? t('att.emptyFiltered') : t('att.empty')}
          body={filtered ? t('att.emptyFilteredBody') : t('att.emptyBody')}
          action={
            filtered
              ? {
                  label: t('att.clearFilters'),
                  onClick: () => {
                    setSearch('');
                    p.set({ project: null, type: null, by: null, from: null, to: null, q: null });
                  },
                }
              : undefined
          }
        />
      ) : view === 'grid' ? (
        <ul className="at-grid" aria-label={t('att.listAria')}>
          {items.map((f) => (
            <li key={f.id} className="at-card">
              <button type="button" className="at-card-open" onClick={() => void openFile(f)} aria-label={t('att.openFile', { task: f.task.name })}>
                <Thumb file={f} />
              </button>
              <div className="at-card-body">
                <Link to={taskLink(f)} className="at-task">
                  {f.task.name}
                </Link>
                <span className="at-meta">
                  <IconFolder size={13} aria-hidden /> {f.project.name}
                </span>
                <span className="at-meta at-meta--quiet">
                  {t(`att.kind.${f.type}` as MessageKey)} · {fileSize(f.sizeBytes)} · {formatDate(f.createdAt)}
                </span>
                {f.uploadedBy ? <span className="at-meta at-meta--quiet">{t('att.by', { name: f.uploadedBy.fullName })}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="at-table-wrap">
          <table className="at-table">
            <thead>
              <tr>
                <th>{t('att.col.file')}</th>
                <th>{t('att.col.task')}</th>
                <th>{t('att.col.project')}</th>
                <th>{t('att.col.by')}</th>
                <th>{t('att.col.date')}</th>
                <th>{t('att.col.size')}</th>
                <th aria-label={t('att.col.actions')} />
              </tr>
            </thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id}>
                  <td>
                    <button type="button" className="at-row-file" onClick={() => void openFile(f)}>
                      <Thumb file={f} size="row" />
                      <span>{t(`att.kind.${f.type}` as MessageKey)}</span>
                    </button>
                  </td>
                  <td>
                    <Link to={taskLink(f)} className="at-task">
                      {f.task.name}
                    </Link>
                  </td>
                  <td>{f.project.name}</td>
                  <td>{f.uploadedBy?.fullName ?? t('common.none')}</td>
                  <td className="num">{formatDateTime(f.createdAt)}</td>
                  <td className="num">{fileSize(f.sizeBytes)}</td>
                  <td>
                    <Tooltip label={t('att.goToTask')}>
                      <ActionIcon component={Link} to={taskLink(f)} variant="subtle" aria-label={t('att.goToTask')}>
                        <IconExternalLink size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {items.length ? (
        <div className="at-foot">
          <span>{t('att.shown', { n: items.length, total: list.data?.total ?? items.length })}</span>
          {list.data && list.data.total > items.length && size < 100 ? (
            <Button variant="subtle" size="compact-sm" onClick={() => setSize(100)} loading={list.isFetching}>
              {t('att.more')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <Lightbox
        files={images}
        index={preview}
        onIndex={setPreview}
        taskLink={taskLink}
      />
    </>
  );
}

function Lightbox({
  files,
  index,
  onIndex,
  taskLink,
}: {
  files: AttachmentBrowseDto[];
  index: number | null;
  onIndex: (i: number | null) => void;
  taskLink: (f: AttachmentBrowseDto) => string;
}) {
  const file = index !== null ? files[index] : undefined;
  const url = useFileUrl(file, Boolean(file));
  const prev = () => index !== null && onIndex((index - 1 + files.length) % files.length);
  const next = () => index !== null && onIndex((index + 1) % files.length);
  useEffect(() => {
    if (!file) return;
    const onKey = (e: KeyboardEvent) => {
      // Arrow keys are physical: in RTL the right arrow goes back (to the previous item).
      const rtl = dirSign() === -1;
      const back = rtl ? 'ArrowRight' : 'ArrowLeft';
      const fwd = rtl ? 'ArrowLeft' : 'ArrowRight';
      if (e.key === back) prev();
      if (e.key === fwd) next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <Modal
      opened={Boolean(file)}
      onClose={() => onIndex(null)}
      size="xl"
      centered
      title={file ? `${file.task.name} — ${t('att.imageOf', { n: (index ?? 0) + 1, total: files.length })}` : ''}
      classNames={{ body: 'at-lightbox' }}
    >
      {file ? (
        <>
          <div className="at-lightbox-stage">
            {url.data ? (
              <img src={url.data.url} alt={t('att.imageAlt', { task: file.task.name })} referrerPolicy="no-referrer" />
            ) : (
              <Loader />
            )}
          </div>
          <div className="at-lightbox-bar">
            <Button variant="default" leftSection={<IconArrowLeft size={16} className="mirror-rtl" />} onClick={prev} disabled={files.length < 2}>
              {t('att.prev')}
            </Button>
            <Button component={Link} to={taskLink(file)} variant="light" leftSection={<IconExternalLink size={16} />}>
              {t('att.goToTask')}
            </Button>
            <Button variant="default" rightSection={<IconArrowRight size={16} className="mirror-rtl" />} onClick={next} disabled={files.length < 2}>
              {t('att.next')}
            </Button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
