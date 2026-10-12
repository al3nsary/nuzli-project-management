import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  FileButton,
  Group,
  Modal,
  Progress,
  Stack,
  Text,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconCamera, IconPhotoUp, IconTrash } from '@tabler/icons-react';
import { useApi } from '../../api/context';
import { errorMessage } from '../../api/errors';
import type { PhotoTarget } from '../../api/client';
import { useInvalidatePhotos } from '../../api/photoQueries';
import {
  initialCrop,
  loadImage,
  prepareSource,
  renderCrop,
  validateDimensions,
  validateSource,
  type CropState,
  type LoadedImage,
} from '../../features/photos/crop';
import { formatNumber, t } from '../../i18n';
import { PhotoAvatar } from '../UserAvatar';
import { PhotoCropper } from './PhotoCropper';

export interface PhotoUploaderProps {
  target: PhotoTarget;
  /** For the initials and the dialogs. */
  name: string;
  hasPhoto: boolean;
  fileId?: string | null;
  /** False shows the photo only (no actions). */
  canEdit?: boolean;
  /** After a successful upload or removal (the photo queries are already invalidated). */
  onChanged?: () => void;
  size?: number;
}

/**
 * Choose or take a photo → validate → crop square (circular guide) → upload with progress;
 * replace and remove with a confirmation (owner request A8). Who may use it is decided by the
 * caller (`canEdit`); the API enforces the same rules.
 */
export function PhotoUploader({
  target,
  name,
  hasPhoto,
  fileId,
  canEdit = true,
  onChanged,
  size = 96,
}: PhotoUploaderProps) {
  const api = useApi();
  const invalidate = useInvalidatePhotos();
  const coarse = useMediaQuery('(pointer: coarse)');
  const narrow = useMediaQuery('(max-width: 420px)');
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [crop, setCrop] = useState<CropState | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => () => image?.release(), [image]);

  const closeCrop = useCallback(() => {
    if (progress !== null) return;
    setImage(null);
    setCrop(null);
  }, [progress]);

  const onFile = async (file: File | null) => {
    if (!file) return;
    setError(null);
    const bad = validateSource(file);
    if (bad) {
      setError(t(bad));
      return;
    }
    setPreparing(true);
    try {
      const loaded = await loadImage(await prepareSource(file));
      const small = validateDimensions(loaded.width, loaded.height);
      if (small) {
        loaded.release();
        setError(t(small));
        return;
      }
      setImage(loaded);
      setCrop(initialCrop(loaded.width, loaded.height));
    } catch {
      setError(t('photo.err.read'));
    } finally {
      setPreparing(false);
    }
  };

  const save = async () => {
    if (!image || !crop) return;
    setError(null);
    setProgress(0);
    try {
      const blob = await renderCrop(image, crop);
      await api.photos.upload(target, blob, { onProgress: (f) => setProgress(Math.round(f * 100)) });
      await invalidate(target);
      notifications.show({ color: 'ok', message: t('photo.saved') });
      setProgress(null);
      setImage(null);
      setCrop(null);
      onChanged?.();
    } catch (err) {
      setProgress(null);
      setError(err instanceof Error && ['canvas', 'encode', 'too-large'].includes(err.message) ? t('photo.err.read') : errorMessage(err));
    }
  };

  const remove = async () => {
    setRemoving(true);
    setError(null);
    try {
      await api.photos.remove(target);
      await invalidate(target);
      notifications.show({ color: 'ok', message: t('photo.removed') });
      setConfirmRemove(false);
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err));
      setConfirmRemove(false);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Stack gap="sm" className="nz-photo-uploader">
      <Group gap="md" wrap="nowrap" align="center">
        <PhotoAvatar target={target} name={name} hasPhoto={hasPhoto} fileId={fileId} size={size} />
        <Stack gap={6} style={{ minWidth: 0 }}>
          <Text fw={600}>{t('photo.title')}</Text>
          <Text size="xs" c="dimmed">
            {hasPhoto ? t('photo.hasPhoto') : t('photo.noPhoto')}
          </Text>
          {canEdit ? (
            <Group gap="xs" wrap="wrap">
              <FileButton onChange={(f) => void onFile(f)} accept="image/jpeg,image/png,image/webp">
                {(props) => (
                  <Button
                    {...props}
                    size="xs"
                    variant="light"
                    leftSection={<IconPhotoUp size={16} />}
                    loading={preparing}
                  >
                    {hasPhoto ? t('photo.replace') : t('photo.choose')}
                  </Button>
                )}
              </FileButton>
              {coarse ? (
                <FileButton onChange={(f) => void onFile(f)} accept="image/*" capture="user">
                  {(props) => (
                    <Button {...props} size="xs" variant="default" leftSection={<IconCamera size={16} />}>
                      {t('photo.take')}
                    </Button>
                  )}
                </FileButton>
              ) : null}
              {hasPhoto ? (
                <Button
                  size="xs"
                  variant="subtle"
                  color="breach"
                  leftSection={<IconTrash size={16} />}
                  onClick={() => setConfirmRemove(true)}
                >
                  {t('photo.remove')}
                </Button>
              ) : null}
            </Group>
          ) : null}
        </Stack>
      </Group>
      {canEdit ? (
        <Text size="xs" c="dimmed">
          {t('photo.rules')}
        </Text>
      ) : null}
      {error && !image ? (
        <Alert color="breach" variant="light" role="alert" py="xs">
          {error}
        </Alert>
      ) : null}

      <Modal
        opened={Boolean(image && crop)}
        onClose={closeCrop}
        title={t('photo.crop.title', { name })}
        centered
        size="auto"
        closeOnClickOutside={progress === null}
        closeOnEscape={progress === null}
        withCloseButton={progress === null}
      >
        {image && crop ? (
          <Stack gap="md">
            <PhotoCropper image={image} state={crop} onChange={setCrop} viewPx={narrow ? 248 : 300} />
            {progress !== null ? (
              <Stack gap={4}>
                <Progress value={progress} color="field" animated aria-label={t('photo.uploading')} />
                <Text size="xs" c="dimmed" ta="center" aria-live="polite">
                  {t('photo.uploadingPct', { pct: formatNumber(progress) })}
                </Text>
              </Stack>
            ) : null}
            {error ? (
              <Alert color="breach" variant="light" role="alert" py="xs">
                {error}
              </Alert>
            ) : null}
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={closeCrop} disabled={progress !== null}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => void save()} loading={progress !== null}>
                {t('photo.save')}
              </Button>
            </Group>
          </Stack>
        ) : null}
      </Modal>

      <Modal
        opened={confirmRemove}
        onClose={() => !removing && setConfirmRemove(false)}
        title={t('photo.removeTitle', { name })}
        centered
      >
        <Stack gap="md">
          <Text size="sm">{t('photo.removeBody')}</Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setConfirmRemove(false)} disabled={removing}>
              {t('common.cancel')}
            </Button>
            <Button color="breach" loading={removing} onClick={() => void remove()}>
              {t('photo.remove')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

/** The uploader in a dialog (card editor: «تغيير الصورة»). */
export function PhotoUploaderModal({
  opened,
  onClose,
  ...props
}: PhotoUploaderProps & { opened: boolean; onClose: () => void }) {
  return (
    <Modal opened={opened} onClose={onClose} title={t('photo.changeFor', { name: props.name })} centered>
      <PhotoUploader {...props} />
    </Modal>
  );
}
