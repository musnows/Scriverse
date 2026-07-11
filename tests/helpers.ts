import { createRuntime, type Runtime } from "../src/app.js";

export function createTestRuntime(fetchImpl?: typeof fetch): Runtime {
  const runtime = createRuntime({
    databasePath: ":memory:",
    masterSecret: "test-master-secret-with-at-least-32-characters",
    ...(fetchImpl ? { fetchImpl } : {}),
    serveUi: false
  });
  // 每个测试运行时复用同一个本地监听端口，避免 Supertest 为每次请求反复创建临时端口。
  const server = runtime.app.listen(0);
  server.unref();
  return {
    ...runtime,
    app: server as unknown as Runtime["app"],
    close: () => {
      server.closeAllConnections();
      server.close();
      runtime.close();
    }
  };
}

export async function createWork(runtime: Runtime, title = "测试作品"): Promise<Record<string, unknown>> {
  return runtime.store.createWork({ title, author: "测试作者" });
}

export async function seedChapter(runtime: Runtime, content = "黎明时，林舟抵达北港。"): Promise<{
  work: Record<string, unknown>;
  volume: Record<string, unknown>;
  chapter: Record<string, unknown>;
}> {
  const work = await createWork(runtime);
  const volume = runtime.store.createVolume(String(work.id), { title: "第一卷 起航" });
  const chapter = runtime.store.createChapter(String(work.id), {
    volumeId: String(volume.id),
    title: "第一章 抵达",
    content
  });
  return { work, volume, chapter };
}
