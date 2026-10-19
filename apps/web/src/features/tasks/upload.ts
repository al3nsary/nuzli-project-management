import type { QueryClient } from '@tanstack/react-query';
import { ALLOWED_UPLOAD_TYPES, MAX_UPLOAD_BYTES } from '@nuzli/shared';
import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { qk4 } from '../../api/projectQueries';

/**
 * A task attachment upload (ADR-058): presign with `entityType: 'task'` → PUT → confirm. The
 * confirm links the file to the task. Type and size are checked first so the user gets the
 * Arabic error before any bytes move.
 */
export async function uploadTaskFile(api: ApiClient, taskId: string, file: File): Promise<string> {
  if (!(ALLOWED_UPLOAD_TYPES as readonly string[]).includes(file.type)) throw ApiError.of('FILE_TYPE_NOT_ALLOWED', 415);
  if (file.size > MAX_UPLOAD_BYTES) throw ApiError.of('FILE_TOO_LARGE', 413);
  const p = await api.files.presign({ entityType: 'task', entityId: taskId, kind: 'ATTACHMENT', contentType: file.type as never, sizeBytes: file.size });
  await api.files.upload(p, file);
  await api.files.confirm(p.fileId);
  return p.fileId;
}

/** After a task attachment changed: its list, the counts on the chart and the cross-task pages. */
export function invalidateTaskFiles(qc: QueryClient, taskId: string, projectId?: string) {
  void qc.invalidateQueries({ queryKey: qk4.attachments(taskId) });
  void qc.invalidateQueries({ queryKey: ['task', taskId, 'dto'] });
  void qc.invalidateQueries({ queryKey: ['attachments'] });
  if (projectId) void qc.invalidateQueries({ queryKey: qk4.gantt(projectId) });
}

export const isImage = (mime: string) => mime.startsWith('image/');
