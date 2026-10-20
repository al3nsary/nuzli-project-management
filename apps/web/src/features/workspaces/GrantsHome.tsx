import { Link } from 'react-router-dom';
import { Card, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconFolders } from '@tabler/icons-react';
import { useAuthStore } from '../../stores/auth';
import { useMyParticipations } from '../../api/a12Queries';
import { useNavModel } from '../../app/shell/useNavModel';
import { navLeaves } from '../../app/nav';
import { EmptyState, LoadingBlock } from '../../components/ui';
import { t, tKey } from '../../i18n';
import './workspaces.css';

/**
 * A12: the home page of an assistant (مساعد) or a member who is a project participant — what their
 * grants open (the pages of the navigation they can see) and their projects with the level there.
 * Never the monitor's recording home (the API's display role is not a right).
 */
export function GrantsHome() {
  const user = useAuthStore((s) => s.user);
  const { tree } = useNavModel();
  const parts = useMyParticipations();
  const pages = navLeaves(tree).filter((n) => n.id !== 'dashboard' && n.id !== 'notifications');
  if (!user) return null;
  return (
    <Stack gap="lg">
      {parts.isLoading ? (
        <LoadingBlock variant="cards" />
      ) : parts.data?.length ? (
        <section aria-labelledby="gh-projects">
          <Title order={2} id="gh-projects" size="h4" mb="sm">
            {t('grantsHome.projects')}
          </Title>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
            {parts.data.map((p) => (
              <Card key={p.projectId} component={Link} to={`/projects/${encodeURIComponent(p.projectId)}`} withBorder radius="lg" padding="lg" className="nz-gh-card">
                <Text fw={700} size="md" lineClamp={2}>
                  {p.projectName}
                </Text>
                <Text size="sm" c="dimmed" mt={4}>
                  {p.title}
                </Text>
                <span className="pill brand" style={{ marginTop: 10, alignSelf: 'flex-start' }}>
                  {tKey(`participantLevel.${p.level}`, 'common.none')}
                </span>
              </Card>
            ))}
          </SimpleGrid>
        </section>
      ) : null}
      {pages.length ? (
        <section aria-labelledby="gh-pages">
          <Title order={2} id="gh-pages" size="h4" mb="sm">
            {t('grantsHome.pages')}
          </Title>
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 4 }} spacing="sm">
            {pages.map((n) => (
              <Card key={n.id} component={Link} to={n.path!} withBorder radius="lg" padding="md" className="nz-gh-card">
                <span className="nz-ws-ic" aria-hidden>
                  <n.icon size={20} stroke={1.7} />
                </span>
                <Text fw={600} size="sm" mt={8}>
                  {t(n.title ?? n.label)}
                </Text>
              </Card>
            ))}
          </SimpleGrid>
        </section>
      ) : null}
      {!pages.length && !parts.isLoading && !parts.data?.length ? (
        <EmptyState icon={IconFolders} title={t('grantsHome.emptyTitle')} body={t('grantsHome.emptyBody')} />
      ) : null}
    </Stack>
  );
}
