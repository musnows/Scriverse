import { describe, expect, it } from "vitest";
import { createStreamTypewriter, createStreamTypewriterSpeedController, streamTypewriterBatchSize } from "../../src/public/stream-typewriter.js";
// @ts-expect-error 浏览器端 Markdown 模块没有单独的类型声明，测试仅调用纯函数导出。
import { renderMarkdown } from "../../src/public/markdown.js";

function manualFrames() {
  const callbacks: Array<() => void> = [];
  return {
    schedule(callback: () => void) {
      callbacks.push(callback);
      return callback;
    },
    cancel(callback: () => void) {
      const index = callbacks.indexOf(callback);
      if (index >= 0) callbacks.splice(index, 1);
    },
    runNext() {
      callbacks.shift()?.();
    },
    runAll(limit = 200) {
      let count = 0;
      while (callbacks.length && count < limit) {
        callbacks.shift()?.();
        count += 1;
      }
      return count;
    }
  };
}

describe("流式打字机", () => {
  it("逐帧显示收到的 Unicode 字符并在完成时返回全文", async () => {
    const frames = manualFrames();
    const renders: string[] = [];
    const typewriter = createStreamTypewriter({
      onRender: (text) => renders.push(text),
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      reducedMotion: false
    });

    typewriter.append("你好");
    typewriter.append("，A");
    frames.runNext();
    expect(renders).toEqual(["你"]);

    const completed = typewriter.finish();
    expect(frames.runAll()).toBe(2);
    await expect(completed).resolves.toBe("你好，A");
    expect(renders.at(-1)).toBe("你好，A");
  });

  it("在减少动态效果时单帧显示完整内容", async () => {
    const frames = manualFrames();
    const renders: string[] = [];
    const typewriter = createStreamTypewriter({
      onRender: (text) => renders.push(text),
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      reducedMotion: true
    });

    typewriter.append("完整回复");
    const completed = typewriter.finish();
    expect(frames.runAll()).toBe(1);
    await expect(completed).resolves.toBe("完整回复");
    expect(renders).toEqual(["完整回复"]);
  });

  it("中断时立即显露所有已收到的字符并取消待处理帧", () => {
    const frames = manualFrames();
    const renders: string[] = [];
    const typewriter = createStreamTypewriter({
      onRender: (text) => renders.push(text),
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      reducedMotion: false
    });

    typewriter.append("部分回复");
    expect(typewriter.reveal()).toBe("部分回复");
    expect(frames.runAll()).toBe(0);
    expect(renders).toEqual(["部分回复"]);
  });

  it("限制生成和收尾阶段每帧显示的字符数", () => {
    expect(streamTypewriterBatchSize(0)).toBe(0);
    expect(streamTypewriterBatchSize(4)).toBe(1);
    expect(streamTypewriterBatchSize(180)).toBe(6);
    expect(streamTypewriterBatchSize(180, true)).toBe(13);
    expect(streamTypewriterBatchSize(5_000)).toBe(12);
    expect(streamTypewriterBatchSize(5_000, true)).toBe(24);
  });

  it("根据共享流速让后续轮次继承较快的显示速度", () => {
    let currentTime = 0;
    const speedController = createStreamTypewriterSpeedController({ now: () => currentTime });
    speedController.observe(180);

    expect(speedController.charactersPerSecond()).toBe(360);
    expect(streamTypewriterBatchSize(12, false, speedController.charactersPerSecond())).toBe(6);

    currentTime = 100;
    speedController.observe(60);
    expect(speedController.charactersPerSecond()).toBeGreaterThan(60);
    expect(streamTypewriterBatchSize(12, false, speedController.charactersPerSecond())).toBeGreaterThan(1);
  });

  it("跨轮次空档保留已观测到的追赶速度", () => {
    let currentTime = 0;
    const speedController = createStreamTypewriterSpeedController({ now: () => currentTime });
    speedController.observe(180);
    currentTime = 5_000;
    speedController.observe(3);

    expect(speedController.charactersPerSecond()).toBe(360);
    expect(streamTypewriterBatchSize(12, false, speedController.charactersPerSecond())).toBe(6);
  });

  it("两个独立轮次的打字机共享追赶速度", () => {
    const firstFrames = manualFrames();
    const secondFrames = manualFrames();
    const speedController = createStreamTypewriterSpeedController({ now: () => 0 });
    const firstRenders: string[] = [];
    const secondRenders: string[] = [];
    const firstTypewriter = createStreamTypewriter({
      onRender: (text) => firstRenders.push(text),
      scheduleFrame: firstFrames.schedule,
      cancelFrame: firstFrames.cancel,
      reducedMotion: false,
      speedController
    });
    const secondTypewriter = createStreamTypewriter({
      onRender: (text) => secondRenders.push(text),
      scheduleFrame: secondFrames.schedule,
      cancelFrame: secondFrames.cancel,
      reducedMotion: false,
      speedController
    });

    firstTypewriter.append("字".repeat(180));
    firstFrames.runNext();
    secondTypewriter.append("第二轮思考内容");
    secondFrames.runNext();

    expect(firstRenders[0]).toHaveLength(6);
    expect(secondRenders[0]).toHaveLength(6);
  });

  it("大量文本积压时按积压量平滑加速", async () => {
    const frames = manualFrames();
    const lengths: number[] = [];
    const typewriter = createStreamTypewriter({
      onRender: (text) => lengths.push(Array.from(text).length),
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      reducedMotion: false
    });

    typewriter.append("字".repeat(180));
    frames.runNext();
    expect(lengths).toEqual([6]);

    const completed = typewriter.finish();
    expect(frames.runAll()).toBeLessThan(30);
    await expect(completed).resolves.toBe("字".repeat(180));
    expect(lengths.every((length, index) => index === 0 || length - (lengths[index - 1] ?? 0) <= 24)).toBe(true);
  });

  it("逐帧解析复杂 Markdown 并在完成时渲染为真实表格", async () => {
    const frames = manualFrames();
    const renderedFrames: string[] = [];
    const markdown = [
      "### 航行状态",
      "",
      "| 舰船 | 状态 | 备注 |",
      "| :--- | :---: | ---: |",
      "| 远航号 | **跃迁完成** | `冷却 12h` |",
      "| 归潮号 | 检修中 | 引擎\\|护盾 |",
      "",
      "- 表格后列表仍然可用",
      "",
      "```txt",
      "航线已锁定",
      "```"
    ].join("\n");
    const typewriter = createStreamTypewriter({
      onRender: (text) => renderedFrames.push(renderMarkdown(text)),
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      reducedMotion: false
    });

    typewriter.append(markdown.slice(0, 42));
    frames.runNext();
    typewriter.append(markdown.slice(42));
    const completed = typewriter.finish();
    frames.runAll();

    await expect(completed).resolves.toBe(markdown);
    expect(renderedFrames.length).toBeGreaterThan(2);
    expect(renderedFrames.some((html) => !html.includes("<table>"))).toBe(true);
    expect(renderedFrames.some((html) => html.includes("<table>"))).toBe(true);
    expect(renderedFrames.at(-1)).toContain('<div class="markdown-table-scroll" role="region" aria-label="Markdown 表格" tabindex="0">');
    expect(renderedFrames.at(-1)).toContain("<thead><tr>");
    expect(renderedFrames.at(-1)).toContain('<tbody><tr><td class="markdown-align-left">远航号</td>');
    expect(renderedFrames.at(-1)).toContain('<td class="markdown-align-center"><strong>跃迁完成</strong></td>');
    expect(renderedFrames.at(-1)).toContain('<td class="markdown-align-right"><code>冷却 12h</code></td>');
    expect(renderedFrames.at(-1)).toContain('<td class="markdown-align-right">引擎|护盾</td>');
    expect(renderedFrames.at(-1)).toContain("<ul><li");
    expect(renderedFrames.at(-1)).toContain('<pre><code class="language-txt">航线已锁定</code></pre>');
  });
});
