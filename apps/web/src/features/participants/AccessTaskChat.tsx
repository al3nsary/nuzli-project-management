import { TaskChat, type TaskChatProps } from '../chat/TaskChat';
import { useTaskAccess } from './access';

/**
 * A12 round 2: the task chat with «may write / may attach» from the task relation — a contributor or
 * editor participant writes and attaches, a viewer only reads, a co-supervisor replies (no files).
 */
export function AccessTaskChat(props: Omit<TaskChatProps, 'canWrite' | 'canUpload'> & { projectId: string }) {
  const access = useTaskAccess({ projectId: props.projectId, assignee: props.assignee });
  return <TaskChat {...props} canWrite={access.comment} canUpload={access.attach} />;
}
