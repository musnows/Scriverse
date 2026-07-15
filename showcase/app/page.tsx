"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type RelationKind = "亲属" | "社交" | "情感" | "冲突";

type StoryNode = {
  id: string;
  name: string;
  group: string;
  x: number;
  y: number;
  size: number;
  color: string;
};

type StoryEdge = {
  from: string;
  to: string;
  kind: RelationKind;
  label: string;
  evidence: string;
};

const storyNodes: StoryNode[] = [
  { id: "lin", name: "林砚", group: "烬城调查局", x: 50, y: 42, size: 19, color: "#9a8fb5" },
  { id: "yao", name: "姚灯", group: "烬城调查局", x: 27, y: 28, size: 15, color: "#7a9bb5" },
  { id: "shen", name: "沈星河", group: "北陆议会", x: 73, y: 26, size: 17, color: "#b58a9a" },
  { id: "su", name: "苏弦", group: "拾光商会", x: 79, y: 61, size: 13, color: "#8aa8a3" },
  { id: "lu", name: "陆归", group: "北陆议会", x: 53, y: 76, size: 14, color: "#b58a9a" },
  { id: "ji", name: "纪青梧", group: "无所属", x: 22, y: 68, size: 12, color: "#a89a88" },
  { id: "he", name: "贺云川", group: "烬城调查局", x: 42, y: 16, size: 11, color: "#7a9bb5" },
];

const storyEdges: StoryEdge[] = [
  { from: "lin", to: "yao", kind: "情感", label: "旧日搭档", evidence: "第二卷第 18 章：姚灯认出了林砚惯用的暗号。" },
  { from: "lin", to: "shen", kind: "冲突", label: "立场对立", evidence: "第三卷第 4 章：两人在议会听证会上公开交锋。" },
  { from: "lin", to: "lu", kind: "亲属", label: "同母异父", evidence: "第一卷第 27 章：族谱残页确认两人的母系血缘。" },
  { from: "lin", to: "ji", kind: "社交", label: "线人", evidence: "第二卷第 8 章：纪青梧交付了北港货运清单。" },
  { from: "yao", to: "he", kind: "社交", label: "直属上下级", evidence: "第一卷第 3 章：贺云川将调查任务交给姚灯。" },
  { from: "shen", to: "su", kind: "社交", label: "利益同盟", evidence: "第三卷第 1 章：商会与议会达成临时协定。" },
  { from: "shen", to: "lu", kind: "情感", label: "隐秘守护", evidence: "第三卷第 12 章：沈星河替陆归销毁了通行记录。" },
  { from: "su", to: "lu", kind: "冲突", label: "旧债", evidence: "第二卷第 22 章：苏弦要求陆归偿还十年前的代价。" },
  { from: "ji", to: "yao", kind: "亲属", label: "远房表亲", evidence: "角色档案：纪氏族谱支系记录。" },
];

const relationColors: Record<RelationKind, string> = {
  亲属: "#43e39a",
  社交: "#438cff",
  情感: "#ff5f69",
  冲突: "#ffad42",
};

const capabilities = [
  ["01", "作品书架", "集中管理多部作品、封面、作者、简介与作品级访问权限。"],
  ["02", "正文编辑", "分卷章节树、自动保存、行号引用、版本回滚与空行整理。"],
  ["03", "智能导入", "导入 TXT 或 DOCX，自动识别分卷、章节、设定与后记结构。"],
  ["04", "世界设定", "把地点、规则、道具与硬约束沉淀为可检索、可锁定的知识。"],
  ["05", "角色档案", "角色别名、属性、种族、组织归属与长篇档案都保留版本。"],
  ["06", "种族与组织", "维护种族体系、组织设定和成员关系，支持多重归属。"],
  ["07", "时间线看板", "在多条事件轨道上拆分、合并、排序，并追踪章节证据。"],
  ["08", "人物关系", "记录关系类型、关键词、置信度和证据，并自动生成可交互图谱。"],
  ["09", "大纲与伏笔", "管理章节目标、冲突、转折，以及伏笔的埋设、提醒和回收。"],
  ["10", "AI 创作助手", "对话、续写、校对与三种剧情方向，流式输出且支持精确引用。"],
  ["11", "分析任务", "结构、章节、角色、时间线、关系和一致性分析可批量编排。"],
  ["12", "搜索与导出", "全文检索正文与知识库，安全导出 JSON、TXT 和 Markdown。"],
];

function Brand() {
  return (
    <a className="brand" href="#top" aria-label="叙界首页">
      <span className="brand-mark">叙</span>
      <span><strong>叙界</strong><small>SCRIVERSE</small></span>
    </a>
  );
}

function RelationshipGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState("lin");
  const [showLabels, setShowLabels] = useState(true);

  const connectedEdges = useMemo(
    () => storyEdges.filter((edge) => edge.from === selected || edge.to === selected),
    [selected],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const draw = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);
      context.clearRect(0, 0, width, height);
      for (const edge of storyEdges) {
        const from = storyNodes.find((node) => node.id === edge.from);
        const to = storyNodes.find((node) => node.id === edge.to);
        if (!from || !to) continue;
        const active = edge.from === selected || edge.to === selected;
        context.beginPath();
        context.moveTo((from.x / 100) * width, (from.y / 100) * height);
        context.lineTo((to.x / 100) * width, (to.y / 100) * height);
        context.strokeStyle = active ? "rgba(255,255,255,.7)" : "rgba(255,255,255,.17)";
        context.lineWidth = active ? 1.5 : 1;
        context.stroke();
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(host);
    return () => observer.disconnect();
  }, [selected]);

  const selectedNode = storyNodes.find((node) => node.id === selected) ?? storyNodes[0];

  return (
    <div className="relationship-demo">
      <div className="graph-toolbar">
        <div><strong>烬城人物网络</strong><small>7 位角色 · 9 条有效关系</small></div>
        <div className="graph-legend" aria-label="关系类型图例">
          {(Object.keys(relationColors) as RelationKind[]).map((kind) => (
            <span key={kind}><i style={{ background: relationColors[kind] }} />{kind}</span>
          ))}
        </div>
        <button className="dark-button" type="button" onClick={() => setShowLabels((value) => !value)} aria-pressed={showLabels}>
          {showLabels ? "隐藏标签" : "显示标签"}
        </button>
      </div>
      <div className="relationship-stage" ref={hostRef}>
        <canvas ref={canvasRef} aria-hidden="true" />
        <div className="graph-focus"><span>选中角色</span><strong>{selectedNode.name}</strong><small>{selectedNode.group}</small></div>
        {storyNodes.map((node) => {
          const related = connectedEdges.some((edge) => edge.from === node.id || edge.to === node.id);
          const dimmed = node.id !== selected && !related;
          return (
            <button
              className={`relation-node${node.id === selected ? " is-selected" : ""}${dimmed ? " is-dimmed" : ""}`}
              key={node.id}
              type="button"
              onClick={() => setSelected(node.id)}
              aria-label={`查看角色 ${node.name}`}
              style={{ left: `${node.x}%`, top: `${node.y}%`, "--node-size": `${node.size}px`, "--node-color": node.color } as React.CSSProperties}
            >
              <i />
              {showLabels && <span>{node.name}</span>}
            </button>
          );
        })}
        <p className="graph-help">点击角色聚焦关系 · 每条结论均可回到原文证据</p>
      </div>
      <div className="evidence-panel" aria-live="polite">
        <span className="evidence-index">{String(connectedEdges.length).padStart(2, "0")}</span>
        <div><strong>{selectedNode.name}的关系证据</strong><p>{connectedEdges[0]?.label}：{connectedEdges[0]?.evidence}</p></div>
        <span className="evidence-status">已确认</span>
      </div>
    </div>
  );
}

function GalaxyGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef("lin");
  const labelsRef = useRef(true);
  const starsRef = useRef(true);
  const pausedRef = useRef(false);
  const hitAreasRef = useRef<Array<{ id: string; x: number; y: number; radius: number }>>([]);
  const [selected, setSelected] = useState("lin");
  const [labels, setLabels] = useState(true);
  const [stars, setStars] = useState(true);
  const [paused, setPaused] = useState(false);

  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { labelsRef.current = labels; }, [labels]);
  useEffect(() => { starsRef.current = stars; }, [stars]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const starSeed = Array.from({ length: 130 }, (_, index) => ({
      x: ((index * 73) % 997) / 997,
      y: ((index * 149) % 991) / 991,
      radius: 0.35 + (index % 7) * 0.18,
      alpha: 0.2 + (index % 5) * 0.13,
    }));
    let frame = 0;
    let angle = 0;
    const draw = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      const ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
        canvas.width = Math.floor(width * ratio);
        canvas.height = Math.floor(height * ratio);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const glow = context.createRadialGradient(width * 0.5, height * 0.46, 20, width * 0.5, height * 0.46, width * 0.62);
      glow.addColorStop(0, "#101a33");
      glow.addColorStop(0.48, "#080d19");
      glow.addColorStop(1, "#03050a");
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);
      if (starsRef.current) {
        for (const star of starSeed) {
          context.beginPath();
          context.arc(star.x * width, star.y * height, star.radius, 0, Math.PI * 2);
          context.fillStyle = `rgba(220,235,255,${star.alpha})`;
          context.fill();
        }
      }
      if (!pausedRef.current) angle += 0.0014;
      const centerX = width * 0.5;
      const centerY = height * 0.49;
      const scaleX = Math.min(width * 0.37, 410);
      const scaleY = Math.min(height * 0.31, 190);
      const projected = storyNodes.map((node, index) => {
        const originalAngle = Math.atan2(node.y - 50, node.x - 50) + angle;
        const radius = 0.25 + Math.hypot(node.x - 50, node.y - 50) / 78;
        const depth = Math.sin(originalAngle);
        return {
          ...node,
          x: centerX + Math.cos(originalAngle) * scaleX * radius,
          y: centerY + Math.sin(originalAngle) * scaleY * radius,
          depth,
          radius: node.size * (0.58 + (depth + 1) * 0.18),
          order: index,
        };
      });
      const byId = new Map(projected.map((node) => [node.id, node]));
      for (const edge of storyEdges) {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to) continue;
        const active = edge.from === selectedRef.current || edge.to === selectedRef.current;
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.strokeStyle = active ? `${relationColors[edge.kind]}aa` : "rgba(120,155,210,.17)";
        context.lineWidth = active ? 1.2 : 0.7;
        context.stroke();
      }
      const ordered = projected.sort((left, right) => left.depth - right.depth);
      for (const node of ordered) {
        const active = node.id === selectedRef.current;
        const related = storyEdges.some((edge) =>
          (edge.from === selectedRef.current && edge.to === node.id) || (edge.to === selectedRef.current && edge.from === node.id),
        );
        context.save();
        context.shadowColor = active ? "#ffc86b" : related ? "#438cff" : node.color;
        context.shadowBlur = active ? 28 : related ? 18 : 10;
        const nodeGlow = context.createRadialGradient(node.x - node.radius * 0.25, node.y - node.radius * 0.25, 1, node.x, node.y, node.radius);
        nodeGlow.addColorStop(0, "#ffffff");
        nodeGlow.addColorStop(0.24, active ? "#fff4bd" : node.color);
        nodeGlow.addColorStop(1, "#07101f");
        context.fillStyle = nodeGlow;
        context.beginPath();
        context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        context.fill();
        context.restore();
        if (labelsRef.current || active || related) {
          context.font = `${active ? 600 : 400} 11px ui-monospace, SFMono-Regular, monospace`;
          context.textAlign = "center";
          context.fillStyle = active ? "#ffffff" : "rgba(224,236,251,.76)";
          context.fillText(node.name, node.x, node.y + node.radius + 17);
        }
      }
      hitAreasRef.current = projected.map((node) => ({ id: node.id, x: node.x, y: node.y, radius: Math.max(18, node.radius + 8) }));
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, []);

  const selectedNode = storyNodes.find((node) => node.id === selected) ?? storyNodes[0];
  const related = storyEdges.filter((edge) => edge.from === selected || edge.to === selected);

  const pickNode = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const hit = hitAreasRef.current.find((node) => Math.hypot(node.x - x, node.y - y) <= node.radius);
    if (hit) setSelected(hit.id);
  };

  const cycleNode = (direction: number) => {
    const index = storyNodes.findIndex((node) => node.id === selected);
    setSelected(storyNodes[(index + direction + storyNodes.length) % storyNodes.length].id);
  };

  return (
    <div className="galaxy-demo" ref={hostRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={pickNode}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); cycleNode(1); }
          if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); cycleNode(-1); }
        }}
        tabIndex={0}
        aria-label="可交互人物关系银河图，使用方向键切换角色"
      />
      <aside className="galaxy-card" aria-live="polite">
        <span>人物档案</span>
        <strong>{selectedNode.name}</strong>
        <small>{selectedNode.group}</small>
        <p>{related.length} 条关系与当前人物相连。点击星体或使用方向键，查看关系焦点如何随角色切换。</p>
        <div className="galaxy-related">
          {related.slice(0, 3).map((edge) => <span key={`${edge.from}-${edge.to}`}><i style={{ background: relationColors[edge.kind] }} />{edge.label}</span>)}
        </div>
      </aside>
      <div className="galaxy-controls" aria-label="银河图控制">
        <button type="button" onClick={() => setPaused((value) => !value)} aria-pressed={paused}>{paused ? "继续旋转" : "暂停旋转"}</button>
        <button type="button" onClick={() => setLabels((value) => !value)} aria-pressed={labels}>{labels ? "隐藏名称" : "显示名称"}</button>
        <button type="button" onClick={() => setStars((value) => !value)} aria-pressed={stars}>{stars ? "隐藏星尘" : "显示星尘"}</button>
      </div>
      <div className="galaxy-caption"><strong>7</strong><span>角色</span><strong>9</strong><span>关系</span><b>拖动视角 · 点击星体</b></div>
    </div>
  );
}

function WorkspaceMockup() {
  return (
    <div className="workspace-frame" aria-label="叙界正文编辑界面示例">
      <div className="workspace-topbar"><Brand /><span>《烬城来信》 · 第二卷 暗潮</span><div><i /><i /><i /></div></div>
      <aside className="workspace-left">
        <div className="module-pills"><b>正文</b><span>设定库</span><span>角色</span><span>时间轴</span></div>
        <small>作品目录</small>
        <strong>第二卷 · 暗潮</strong>
        <ul><li>12 雨夜访客</li><li className="active">13 灰塔之下</li><li>14 未寄出的信</li></ul>
      </aside>
      <main className="workspace-editor">
        <small>第二卷 / 第十三章</small>
        <h3>灰塔之下</h3>
        <div className="editor-actions"><span>2,846 字 · v12</span><button type="button">章节概览</button><button type="button">保存正文</button></div>
        <div className="manuscript"><i>31</i><p>雨水沿着灰塔的铜檐坠落，像一串被夜色擦亮的标点。</p><i>32</i><p>林砚没有抬头。他在等一个只会敲三次门的人。</p><i>33</i><p><mark>“你迟了七年。”</mark></p><i>34</i><p>门外的人笑了一声，把那封没有署名的信推过门缝。</p></div>
      </main>
      <aside className="workspace-ai">
        <div className="ai-title"><i />AI 创作助手 <span>42%</span></div>
        <small>已引用：当前章节、林砚、灰塔协议</small>
        <div className="ai-message">这一段延续了“等待”意象。根据第 31—34 行，可让来访者先提及旧案，再揭示信件来源，以避免过早暴露身份。</div>
        <div className="ai-suggestion"><b>一致性提醒</b><span>林砚在角色档案中“从不饮酒”，第 39 行的动作需要确认。</span></div>
        <div className="ai-input">继续分析这一场景… <kbd>↵</kbd></div>
      </aside>
    </div>
  );
}

export default function Home() {
  return (
    <main id="top">
      <header className="site-header">
        <Brand />
        <nav aria-label="主导航"><a href="#workspace">工作台</a><a href="#abilities">能力</a><a href="#relationships">关系图</a><a href="#galaxy">银河图</a></nav>
        <a className="header-cta" href="https://github.com/musnows/Scriverse" target="_blank" rel="noreferrer">查看源代码 <span>↗</span></a>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">LOCAL-FIRST AI WRITING STUDIO</span>
          <h1>让宏大的故事，<br />始终<span>有迹可循。</span></h1>
          <p>叙界是为长篇小说而生的本地 AI 创作工作台。正文、世界观、人物关系、时间线与每一次灵感，都在同一个叙事系统里彼此关联。</p>
          <div className="hero-actions"><a className="primary-link" href="#workspace">进入叙界世界</a><a className="text-link" href="#relationships">探索人物图谱 <span>↓</span></a></div>
        </div>
        <div className="hero-orbit" aria-hidden="true">
          <div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" /><div className="orbit-ring ring-three" />
          <span className="orbit-core">叙</span>
          <span className="orbit-node node-a">角色</span><span className="orbit-node node-b">正文</span><span className="orbit-node node-c">时间线</span><span className="orbit-node node-d">伏笔</span>
          <div className="orbit-note"><small>WORLD STATE</small><strong>烬城 · 长夜纪元</strong><span>设定锁定 27 项</span></div>
        </div>
      </section>

      <section className="principles" aria-label="产品原则">
        <article><span>01</span><div><strong>本地优先</strong><small>创作资产与密钥由你掌控</small></div></article>
        <article><span>02</span><div><strong>版本可回溯</strong><small>正文与设定修改都有来路</small></div></article>
        <article><span>03</span><div><strong>结论有证据</strong><small>关系与分析能回到原文</small></div></article>
      </section>

      <section className="section workspace-section" id="workspace">
        <div className="section-heading split-heading"><div><span className="eyebrow">ONE PLACE FOR THE WHOLE STORY</span><h2>一个工作台，<br />承载整部长篇。</h2></div><p>叙界不是一个孤立的文本框。它把创作现场、知识约束与 AI 思考放在同一视野里，让你在写下每一句话时，都看得见故事的全局。</p></div>
        <WorkspaceMockup />
        <div className="workspace-notes"><span><i>01</i>分卷章节树</span><span><i>02</i>沉浸式正文编辑</span><span><i>03</i>带上下文的 AI 对话</span></div>
      </section>

      <section className="section abilities-section" id="abilities">
        <div className="section-heading centered-heading"><span className="eyebrow">A COMPLETE NARRATIVE SYSTEM</span><h2>从第一章，到最后一条伏笔。</h2><p>把长篇创作真正需要的能力，收进一个彼此关联、可追溯的系统。</p></div>
        <div className="capability-grid">
          {capabilities.map(([index, title, description]) => <article key={index}><span>{index}</span><h3>{title}</h3><p>{description}</p><i>→</i></article>)}
        </div>
      </section>

      <section className="graph-section" id="relationships">
        <div className="section-heading graph-heading"><div><span className="eyebrow">RELATIONSHIP INTELLIGENCE</span><h2>人物不是档案，<br />而是一张活的网络。</h2></div><p>关系的类型、方向、强度与证据共同构成叙事张力。点击图中的角色，查看他们如何牵动整个故事。</p></div>
        <RelationshipGraph />
      </section>

      <section className="galaxy-section" id="galaxy">
        <div className="galaxy-heading"><span className="eyebrow">GALAXY VIEW</span><h2>当人物关系，<br />成为一座叙事星系。</h2><p>把重要人物放在故事引力场的中心。旋转、聚焦与追踪，让复杂群像在宏观尺度上依然清晰。</p></div>
        <GalaxyGraph />
      </section>

      <section className="section intelligence-section">
        <div className="section-heading split-heading"><div><span className="eyebrow">AI WITH CONTEXT</span><h2>AI 读懂的，<br />不止是眼前一段。</h2></div><p>章节正文、人物状态、锁定设定和全书概要组成可控上下文。每条建议都清楚说明依据，是否写回始终由作者决定。</p></div>
        <div className="intelligence-grid">
          <article className="ai-console">
            <header><span><i />叙界助手</span><small>上下文 42,310 / 128,000</small></header>
            <div className="source-chips"><span>第十三章</span><span>@林砚</span><span>@灰塔协议</span></div>
            <p>灰塔场景与已锁定的“北门禁行”设定一致。第 34 行信件的出现，与第二卷第 8 章埋下的货运清单形成呼应。</p>
            <blockquote><b>建议的后续方向</b>让姚灯从信封蜡印认出调查局旧徽记，并保留来访者身份到下一章揭示。</blockquote>
            <footer><span>依据：正文 31—34 行 · 设定 2 项</span><button type="button">采纳到草稿</button></footer>
          </article>
          <div className="task-stack">
            <article><span>STRUCTURE</span><strong>全书结构分析</strong><small>识别节奏失衡、叙事断层与章节职责</small><b>完成 84%</b></article>
            <article><span>CHARACTERS</span><strong>角色状态抽取</strong><small>从正文更新身份、关系与关键经历</small><b>12 项待审核</b></article>
            <article><span>CONSISTENCY</span><strong>一致性检查</strong><small>对照锁定设定、时间线和人物状态</small><b>3 处需确认</b></article>
          </div>
        </div>
      </section>

      <section className="workflow-section">
        <div className="section-heading centered-heading"><span className="eyebrow">FROM SPARK TO CANON</span><h2>灵感可以自由，事实必须可靠。</h2></div>
        <div className="workflow-line">
          <article><span>01</span><strong>写下正文</strong><small>在章节中自由创作</small></article>
          <article><span>02</span><strong>AI 提取</strong><small>识别人物、事件与关系</small></article>
          <article><span>03</span><strong>作者审核</strong><small>确认、修订或拒绝建议</small></article>
          <article><span>04</span><strong>沉淀设定</strong><small>进入知识库并保留证据</small></article>
          <article><span>05</span><strong>约束后文</strong><small>写作时自动参与校验</small></article>
        </div>
      </section>

      <section className="section control-section">
        <div className="control-copy"><span className="eyebrow">BUILT FOR SERIOUS STORIES</span><h2>创作自由之下，<br />是一套可靠的秩序。</h2><p>叙界支持多用户协作与作品级权限；密钥加密保存，导出不携带凭据；每一次重要写入都有审计与版本历史。</p><div className="control-tags"><span>作品级权限</span><span>加密密钥</span><span>同源防护</span><span>完整审计</span><span>安全导出</span></div></div>
        <div className="access-card"><header><span>作品协作</span><small>《烬城来信》</small></header><div className="member"><i>陆</i><span><strong>陆离</strong><small>作品所有者</small></span><b>可管理</b></div><div className="member"><i>姚</i><span><strong>姚青</strong><small>联合作者</small></span><b>可编辑</b></div><div className="member"><i>沈</i><span><strong>沈越</strong><small>设定顾问</small></span><b>只读</b></div><footer><span>所有修改均记录操作者</span><button type="button">邀请协作</button></footer></div>
      </section>

      <section className="final-cta">
        <span className="eyebrow">YOUR STORY, IN YOUR HANDS</span>
        <h2>世界由你创造，<br />秩序交给叙界。</h2>
        <p>为复杂、漫长、值得被认真对待的故事而生。</p>
        <a href="https://github.com/musnows/Scriverse" target="_blank" rel="noreferrer">开始构建你的叙事世界 <span>↗</span></a>
      </section>

      <footer className="site-footer"><Brand /><p>面向长篇小说创作的本地 AI 工作台</p><span>SCRIVERSE · 叙事有界，想象无边</span></footer>
    </main>
  );
}
