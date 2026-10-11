import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { AppConfig } from '../config/app-config';

export interface HeadResult {
  exists: boolean;
  size: number;
  contentType: string | null;
}

/**
 * OCI Object Storage through its S3-compatible API, MinIO in dev (ADR-012).
 * The bucket is private: objects are reached only through short-lived presigned URLs.
 * Two clients: `internal` talks to the endpoint from inside the network; `signer` signs URLs
 * for the endpoint the browser can reach (S3_PUBLIC_ENDPOINT, same as S3_ENDPOINT on OCI).
 */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly internal: S3Client;
  private readonly signer: S3Client;
  readonly bucket: string;

  constructor(cfg: AppConfig) {
    const base: S3ClientConfig = {
      region: cfg.S3_REGION,
      forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: cfg.S3_ACCESS_KEY, secretAccessKey: cfg.S3_SECRET_KEY },
      // OCI's S3 API does not accept the newer default checksum headers on presigned PUTs.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
    this.internal = new S3Client({ ...base, endpoint: cfg.S3_ENDPOINT });
    this.signer = new S3Client({ ...base, endpoint: cfg.S3_PUBLIC_ENDPOINT ?? cfg.S3_ENDPOINT });
    this.bucket = cfg.S3_BUCKET;
  }

  /** PUT URL bound to one content type and one exact length. */
  presignPut(key: string, contentType: string, contentLength: number, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.signer,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
      }),
      { expiresIn: ttlSeconds, signableHeaders: new Set(['content-type', 'content-length']) },
    );
  }

  presignGet(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }

  async head(key: string): Promise<HeadResult> {
    try {
      const res = await this.internal.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { exists: true, size: Number(res.ContentLength ?? 0), contentType: res.ContentType ?? null };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as Error).name === 'NotFound') {
        return { exists: false, size: 0, contentType: null };
      }
      throw err;
    }
  }

  /** Reads bytes [start, end] inclusive (ranged GET). */
  async readRange(key: string, start: number, end: number): Promise<Uint8Array> {
    const res = await this.internal.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }),
    );
    return res.Body ? await res.Body.transformToByteArray() : new Uint8Array();
  }

  async readAll(key: string): Promise<Uint8Array> {
    const res = await this.internal.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body ? await res.Body.transformToByteArray() : new Uint8Array();
  }

  async delete(key: string): Promise<void> {
    await this.internal.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Used by /ready. */
  async ping(): Promise<boolean> {
    try {
      await this.internal.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }

  onModuleDestroy(): void {
    this.internal.destroy();
    this.signer.destroy();
  }
}
