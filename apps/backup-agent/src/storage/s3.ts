import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { S3Config } from '../types.js';
import type { ObjectInfo, PutOptions, Storage } from './types.js';

export class S3Storage implements Storage {
  private readonly client: S3Client;

  constructor(private readonly cfg: S3Config) {
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.pathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async put(key: string, body: Readable | Buffer, opts?: PutOptions): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.cfg.bucket,
        Key: key,
        Body: body,
        ...(opts?.retainUntil
          ? { ObjectLockMode: 'GOVERNANCE' as const, ObjectLockRetainUntilDate: opts.retainUntil }
          : {}),
      },
    });
    await upload.done();
  }

  async get(key: string): Promise<Readable> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    if (!r.Body) throw new Error('Leere Antwort vom Speicher');
    return r.Body as Readable;
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of r.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified });
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { key, size: r.ContentLength ?? 0, lastModified: r.LastModified };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}
