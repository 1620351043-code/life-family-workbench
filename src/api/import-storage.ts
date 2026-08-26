import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";
import COS from "cos-nodejs-sdk-v5";

export interface ImportObjectStore {
  readonly production: boolean;
  put(key: string, bytes: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  signedGetUrl?(key: string, expiresAt: Date): string | null;
}

export function importObjectKey(householdId: string, batchId: string) {
  return `households/${householdId}/finance-imports/${batchId}/original`;
}

export function financeExportObjectKey(householdId: string, exportId: string) {
  return `households/${householdId}/finance-exports/${exportId}/ledger.csv`;
}

export function aiMemoryObjectKey(householdId: string, artifactId: string) {
  return `households/${householdId}/ai-memory/${artifactId}`;
}

function safePath(root: string, key: string) {
  const target = normalize(join(root, key));
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel.includes("..")) throw new Error("非法对象存储路径");
  return target;
}

export class LocalImportObjectStore implements ImportObjectStore {
  readonly production = false;

  constructor(private readonly root = process.env.LIFE_IMPORT_STORAGE_ROOT ?? join(process.cwd(), "data", "imports")) {}

  async put(key: string, bytes: Buffer) {
    const target = safePath(this.root, key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { mode: 0o600 });
  }

  async read(key: string) {
    return (await import("node:fs/promises")).readFile(safePath(this.root, key));
  }

  async remove(key: string) {
    await rm(safePath(this.root, key), { force: true });
  }
}

export class MemoryImportObjectStore implements ImportObjectStore {
  readonly production = false;
  readonly objects = new Map<string, Buffer>();

  async put(key: string, bytes: Buffer) {
    this.objects.set(key, Buffer.from(bytes));
  }

  async read(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("对象不存在");
    return Buffer.from(bytes);
  }

  async remove(key: string) {
    this.objects.delete(key);
  }
}

export type TencentCosObjectStoreOptions = {
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
  securityToken?: string;
  serverSideEncryption?: "AES256";
};

type TencentCosClient = {
  putObject(params: Record<string, unknown>): Promise<unknown>;
  getObject(params: Record<string, unknown>): Promise<{ Body: Buffer | Uint8Array | ArrayBuffer | string }>;
  deleteObject(params: Record<string, unknown>): Promise<unknown>;
  getObjectUrl(params: Record<string, unknown>): string;
};

/**
 * Private Tencent COS adapter. Credentials are intentionally supplied only at
 * process startup; no household API ever receives a secret or a bucket URL.
 */
export class TencentCosObjectStore implements ImportObjectStore {
  readonly production = true;
  private readonly client: TencentCosClient;

  constructor(private readonly options: TencentCosObjectStoreOptions, client?: TencentCosClient) {
    this.client = client ?? new COS({
      SecretId: options.secretId,
      SecretKey: options.secretKey,
      SecurityToken: options.securityToken,
      Protocol: "https:",
      ForceSignHost: true,
      KeepAlive: true,
    }) as unknown as TencentCosClient;
  }

  async put(key: string, bytes: Buffer) {
    await this.client.putObject({
      Bucket: this.options.bucket,
      Region: this.options.region,
      Key: key,
      Body: bytes,
      ContentLength: bytes.byteLength,
      ACL: "private",
      ServerSideEncryption: this.options.serverSideEncryption ?? "AES256",
    });
  }

  async read(key: string) {
    const result = await this.client.getObject({ Bucket: this.options.bucket, Region: this.options.region, Key: key });
    if (result.Body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(result.Body));
    return Buffer.from(result.Body);
  }

  async remove(key: string) {
    await this.client.deleteObject({ Bucket: this.options.bucket, Region: this.options.region, Key: key });
  }

  signedGetUrl(key: string, expiresAt: Date) {
    const expires = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
    if (expires <= 0) return null;
    return this.client.getObjectUrl({ Bucket: this.options.bucket, Region: this.options.region, Key: key, Sign: true, Method: "GET", Expires: expires, Protocol: "https:" });
  }
}

export function createProductionCosObjectStoreFromEnv(): TencentCosObjectStore {
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`生产对象存储缺少 ${name}`);
    return value;
  };
  return new TencentCosObjectStore({
    bucket: required("LIFE_COS_BUCKET"),
    region: required("LIFE_COS_REGION"),
    secretId: required("LIFE_COS_SECRET_ID"),
    secretKey: required("LIFE_COS_SECRET_KEY"),
    securityToken: process.env.LIFE_COS_SECURITY_TOKEN?.trim() || undefined,
    serverSideEncryption: "AES256",
  });
}
