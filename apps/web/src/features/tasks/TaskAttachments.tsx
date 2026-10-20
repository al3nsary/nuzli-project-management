/**
 * The attachments of one task: open (signed URL), upload (admins and the assignee) and delete
 * (admins, or the uploader). Images show a thumbnail, PDFs a file icon.
 */
import { useState } from 'react';
import { ActionIcon, Button, FileButton, Group, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDownload, IconFileTypePdf, IconPaperclip, IconTrash } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ALLOWED_UPLOAD_TYPES, can, type TaskAttachmentDto } from '@nuzli/shared';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import { useTaskAttachments } from '../../api/projectQueries';
import { useAuthStore } from '../../stores/auth';
import { formatDateTime, formatNumber, t } from '../../i18n';
import { invalidateTaskFiles, isImage, uploadTaskFile } from './upload';

export function TaskAttachments({
  taskId,
  projectId,
  assigneeId,
  canUpload: canUploadProp,
}: {
  taskId: string;
  projectId?: string;
  assigneeId: string | null;
  /** A12 round 2: the caller's task access (participants upload; a supervisor's team task does not). */
  canUpload?: boolean;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const files = useTaskAttachments(taskId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const admin = can(user, 'tasks.manage');
  const canUpload = canUploadProp ?? (admin || (!!assigneeId && assigneeId === user?.id));

  const upload = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      await uploadTaskFile(api, taskId, file);
      invalidateTaskFiles(qc, taskId, projectId);
      notifications.show({ color: 'ok', message: t('task.fileUploaded') });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const open = async (fileId: string) => {
    try {
      const { url } = await api.tasks.attachmentUrl(taskId, fileId);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const remove = async (fileId: string) => {
    try {
      await api.tasks.removeAttachment(taskId, fileId);
      invalidateTaskFiles(qc, taskId, projectId);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Stack gap="xs">
      {error ? (
        <Text size="sm" c="var(--red)" role="alert">
          {error}
        </Text>
      ) : null}
      {files.isLoading ? (
        <Text size="sm" c="dimmed">
          {t('app.loading')}
        </Text>
      ) : files.isError ? (
        <Text size="sm" c="var(--red)">
          {errorMessage(files.error)}
        </Text>
      ) : !files.data?.length ? (
        <Text size="sm" c="dimmed">
          {t('task.noFiles')}
        </Text>
      ) : (
        <ul className="nz-file-list" aria-label={t('a9s.files.title')}>
          {files.data.map((f, i) => (
            <li key={f.id} className="nz-file-row">
              <FileThumb taskId={taskId} file={f} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <Text size="sm" fw={600} truncate>
                  {t('task.fileName', { n: i + 1, type: isImage(f.mimeType) ? t('task.image') : 'PDF' })}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {t('task.fileMeta', { by: f.uploadedBy?.fullName ?? t('common.unknownUser'), at: formatDateTime(f.createdAt), size: formatNumber(Math.max(1, Math.ceil(f.sizeBytes / 1024))) })}
                </Text>
              </div>
              <Group gap={2} wrap="nowrap">
                <ActionIcon variant="subtle" color="gray" size={36} aria-label={t('a9s.files.open')} onClick={() => void open(f.id)}>
                  <IconDownload size={17} />
                </ActionIcon>
                {admin || f.uploadedBy?.id === user?.id ? (
                  <ActionIcon variant="subtle" color="breach" size={36} aria-label={t('task.removeFile')} onClick={() => void remove(f.id)}>
                    <IconTrash size={17} />
                  </ActionIcon>
                ) : null}
              </Group>
            </li>
          ))}
        </ul>
      )}
      {canUpload ? (
        <FileButton onChange={(f) => void upload(f)} accept={ALLOWED_UPLOAD_TYPES.join(',')}>
          {(props) => (
            <Button {...props} variant="light" leftSection={<IconPaperclip size={16} />} loading={busy} style={{ alignSelf: 'flex-start' }}>
              {t('task.attachFile')}
            </Button>
          )}
        </FileButton>
      ) : null}
    </Stack>
  );
}

function FileThumb({ taskId, file }: { taskId: string; file: TaskAttachmentDto }) {
  const api = useApi();
  const image = isImage(file.mimeType);
  const url = useQuery({
    queryKey: ['task', taskId, 'file-url', file.id],
    queryFn: () => api.tasks.attachmentUrl(taskId, file.id),
    enabled: image,
    staleTime: 4 * 60_000,
  });
  return (
    <span className="nz-file-thumb" aria-hidden>
      {image && url.data?.url ? <img src={url.data.url} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <IconFileTypePdf size={22} style={{ color: image ? 'var(--accent)' : 'var(--red)' }} />}
    </span>
  );
}
