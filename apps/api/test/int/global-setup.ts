/**
 * Starts PostgreSQL 16 and MinIO once for all integration suites, applies the migrations
 * and creates the bucket. Without a container runtime it marks the run as skipped.
 */
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { execSync } from 'node:child_process';
import path from 'node:path';

const MINIO_USER = 'nuzli-minio';
const MINIO_PASSWORD = 'nuzli-minio-secret';
export const INT_BUCKET = 'nuzli-int';

export default async function globalSetup(): Promise<void> {
  const tc = await import('testcontainers');
  try {
    await tc.getContainerRuntimeClient();
  } catch {
    process.env.NUZLI_INT_SKIP = '1';
    console.warn(
      '\n[int] No Docker/container runtime found — integration tests are SKIPPED.\n' +
        '      Install Docker (or set DOCKER_HOST) and run `npm run test:int` again.\n',
    );
    return;
  }

  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const pg = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('nuzli')
    .withUsername('nuzli')
    .withPassword('nuzli')
    .start();

  const minio = await new tc.GenericContainer('minio/minio:latest')
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASSWORD })
    .withExposedPorts(9000)
    .withWaitStrategy(tc.Wait.forHttp('/minio/health/live', 9000))
    .start();

  const s3Endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
  Object.assign(process.env, {
    DATABASE_URL: pg.getConnectionUri(),
    S3_ENDPOINT: s3Endpoint,
    S3_REGION: 'us-east-1',
    S3_BUCKET: INT_BUCKET,
    S3_ACCESS_KEY: MINIO_USER,
    S3_SECRET_KEY: MINIO_PASSWORD,
    S3_FORCE_PATH_STYLE: 'true',
  });

  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '../..'),
    env: process.env,
    stdio: 'inherit',
  });

  const s3 = new S3Client({
    endpoint: s3Endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD },
  });
  await s3.send(new CreateBucketCommand({ Bucket: INT_BUCKET }));
  s3.destroy();

  (globalThis as Record<string, unknown>).__NUZLI_CONTAINERS__ = [pg, minio];
}
