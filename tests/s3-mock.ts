export type MockS3Request = {
  method: string;
  url: string;
  bucket: string;
  key: string;
  query: URLSearchParams;
  byteLength: number;
  authorization: string;
};

export type MockS3Object = {
  body: Buffer;
  lastModified: string;
};

export type MockS3Failure = {
  status: number;
  body: string;
  /** 只对匹配的操作生效；未设置时对所有请求生效。 */
  match?: (request: MockS3Request) => boolean;
};

/** 用于集成测试的最小 S3 兼容服务：支持 PUT、DELETE 与 ListObjectsV2。 */
export class MockS3Service {
  readonly objects = new Map<string, MockS3Object>();
  readonly requests: MockS3Request[] = [];
  failure: MockS3Failure | null = null;

  constructor(private readonly host = "s3.example.com") {}

  get endpoint(): string {
    return `https://${this.host}`;
  }

  seedObject(key: string, body = Buffer.from("seed"), lastModified = new Date().toISOString()): void {
    this.objects.set(key, { body, lastModified });
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  private xmlEscape(value: string): string {
    return value
      .replace(/&/gu, "&amp;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;")
      .replace(/"/gu, "&quot;");
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    const [, bucket = "", ...rest] = url.pathname.split("/");
    const key = rest.join("/");
    const body = init?.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.alloc(0);
    const record: MockS3Request = {
      method,
      url: url.toString(),
      bucket,
      key: decodeURIComponent(key),
      query: url.searchParams,
      byteLength: body.byteLength,
      authorization: headers.get("authorization") ?? ""
    };
    this.requests.push(record);

    if (!record.authorization.startsWith("AWS4-HMAC-SHA256 Credential=")) {
      return new Response("<Error><Code>AccessDenied</Code><Message>Missing signature</Message></Error>", { status: 403 });
    }
    if (this.failure && (this.failure.match?.(record) ?? true)) {
      return new Response(this.failure.body, { status: this.failure.status });
    }

    if (method === "PUT") {
      this.objects.set(record.key, { body, lastModified: new Date().toISOString() });
      return new Response("", { status: 200, headers: { etag: '"mock"' } });
    }
    if (method === "DELETE") {
      this.objects.delete(record.key);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...this.objects.entries()]
        .filter(([objectKey]) => objectKey.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([objectKey, object]) => `<Contents><Key>${this.xmlEscape(objectKey)}</Key><Size>${object.body.byteLength}</Size><LastModified>${object.lastModified}</LastModified></Contents>`)
        .join("");
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${this.xmlEscape(bucket)}</Name><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        { status: 200, headers: { "content-type": "application/xml" } }
      );
    }
    if (method === "GET") {
      const object = this.objects.get(record.key);
      if (!object) return new Response("<Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>", { status: 404 });
      return new Response(new Uint8Array(object.body), { status: 200 });
    }
    return new Response("<Error><Code>MethodNotAllowed</Code><Message>Unsupported</Message></Error>", { status: 405 });
  };
}
