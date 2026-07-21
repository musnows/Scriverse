export const cliResourceTypes = [
  "volume",
  "chapter",
  "setting",
  "character",
  "race",
  "organization",
  "timeline-track",
  "timeline-event",
  "relationship",
  "foreshadow",
  "chapter-outline"
] as const;

export type CliResourceType = typeof cliResourceTypes[number];

export type CliResourceDefinition = {
  description: string;
  scopeArgument: "workId" | "chapterId";
  actions: Array<"list" | "get" | "create" | "update" | "history" | "restore">;
  create: {
    required: string[];
    properties: Record<string, string>;
    example: Record<string, unknown>;
  };
  update: {
    properties: Record<string, string>;
    example: Record<string, unknown>;
  };
  notes?: string[];
};

const changeNote = "可选，最多 500 字；说明本次修改原因，会写入版本历史";

export const cliWorkDefinition = {
  description: "作品元数据",
  actions: ["list", "get", "create", "update"],
  create: {
    required: ["title"],
    properties: {
      title: "作品标题，最多 200 字",
      author: "作者署名",
      description: "作品简介",
      language: "语言标识，例如 zh-CN",
      coverUrl: "外部封面 URL 或 null",
      tags: "标签数组"
    },
    example: { title: "潮汐尽头", author: "慕雪", description: "一部发生在星港群岛的长篇小说。", language: "zh-CN", tags: ["科幻", "群像"] }
  },
  update: {
    properties: {
      title: "新标题",
      author: "新署名",
      description: "新简介",
      language: "语言标识",
      coverUrl: "外部封面 URL 或 null",
      tags: "完整标签数组"
    },
    example: { description: "补充北港议会与潮汐航线的主线简介。", tags: ["科幻", "群像", "政治"] }
  },
  notes: ["作品元数据修改会进入审计日志，但不提供版本回滚。"]
};

export const cliResourceDefinitions = {
  volume: {
    description: "分卷元数据",
    scopeArgument: "workId",
    actions: ["list", "get", "create", "update"],
    create: {
      required: ["title"],
      properties: {
        title: "分卷标题，最多 200 字",
        kind: "main | prequel | extra | epilogue | appendix",
        description: "分卷说明，最多 5000 字",
        keywords: "字符串数组，最多 100 项"
      },
      example: { title: "第一卷 星港", kind: "main", description: "主角离开故乡的开端", keywords: ["启程", "星港"] }
    },
    update: {
      properties: {
        title: "新标题",
        kind: "分卷类型",
        description: "新说明",
        keywords: "完整替换关键词数组",
        sortOrder: "非负整数排序值"
      },
      example: { description: "补充星港政治冲突", keywords: ["启程", "星港", "议会"] }
    },
    notes: ["分卷修改会进入作品审计日志，但不提供版本回滚。"]
  },
  chapter: {
    description: "章节正文与章节元数据",
    scopeArgument: "workId",
    actions: ["list", "get", "create", "update", "history", "restore"],
    create: {
      required: ["volumeId", "title"],
      properties: {
        volumeId: "所属分卷 ID",
        title: "章节标题，最多 300 字",
        content: "正文，最多 200 万字符",
        chapterType: "正文 | 设定 | 作者的话 | 其他"
      },
      example: { volumeId: "volume_xxx", title: "第一章 抵达", content: "黎明时，林舟抵达北港。", chapterType: "正文" }
    },
    update: {
      properties: {
        title: "新标题",
        content: "完整替换正文；长文本推荐使用 --field-file content=chapter.txt",
        excludedFromAnalysis: "是否排除 AI 分析",
        chapterType: "正文 | 设定 | 作者的话 | 其他",
        changeNote
      },
      example: { content: "黎明时，林舟抵达北港，潮声掩住了警报。", changeNote: "增强开场危机感" }
    },
    notes: ["标题或正文变化会生成新章节版本；restore 也会生成新版本。"]
  },
  setting: {
    description: "世界观设定",
    scopeArgument: "workId",
    actions: ["list", "get", "create", "update", "history", "restore"],
    create: {
      required: ["title", "category", "content"],
      properties: {
        title: "设定标题",
        category: "分类",
        content: "设定正文",
        tags: "字符串数组",
        status: "draft | pending | confirmed | deprecated",
        locked: "是否锁定",
        evidence: "证据数组",
        scope: "适用范围对象",
        authorNote: "作者备注"
      },
      example: { title: "北港", category: "地点", content: "北港是潮汐航线的枢纽。", tags: ["港口"], status: "confirmed" }
    },
    update: {
      properties: { title: "新标题", category: "新分类", content: "完整设定正文", tags: "完整标签数组", status: "状态", locked: "锁定状态", evidence: "证据数组", scope: "范围对象", authorNote: "作者备注", changeNote },
      example: { content: "北港是潮汐航线与议会贸易的共同枢纽。", changeNote: "补充政治职能" }
    }
  },
  character: {
    description: "人物档案",
    scopeArgument: "workId",
    actions: ["list", "get", "create", "update", "history", "restore"],
    create: {
      required: ["name"],
      properties: {
        name: "人物主名",
        aliases: "别名数组",
        raceId: "种族 ID 或 null",
        organizationIds: "组织 ID 数组",
        attributes: "结构化属性对象",
        profile: "人物档案对象",
        currentState: "当前状态对象",
        lockedFields: "锁定字段数组",
        visibility: "public | author | collaborators",
        firstChapterId: "首次出场章节 ID 或 null"
      },
      example: { name: "林舟", aliases: ["阿舟"], attributes: { age: 24 }, profile: { motivation: "寻找失踪的姐姐" }, currentState: { location: "北港" } }
    },
    update: {
      properties: { name: "新主名", aliases: "完整别名数组", raceId: "种族 ID 或 null", organizationIds: "完整组织数组", attributes: "完整属性对象", profile: "完整人物档案对象", currentState: "完整当前状态对象", lockedFields: "锁定字段数组", visibility: "可见范围", firstChapterId: "首次出场章节", changeNote },
      example: { currentState: { location: "北港议会", condition: "受伤" }, changeNote: "同步第三章结尾状态" }
    }
  },
  race: {
    description: "种族设定",
    scopeArgument: "workId",
    actions: ["list", "get", "create", "update", "history", "restore"],
    create: {
      required: ["name"],
      properties: { name: "种族名称", parentRaceId: "父种族 ID 或 null", description: "说明", settings: "设定条目数组", memberIds: "人物 ID 数组" },
      example: { name: "潮裔", parentRaceId: null, description: "适应高盐雾环境的人类分支。", settings: ["夜间视力较强"], memberIds: [] }
    },
    update: {
      properties: { name: "新名称", parentRaceId: "新父种族 ID 或 null", description: "新说明", settings: "完整设定数组", memberIds: "完整成员数组", changeNote },
      example: { parentRaceId: null, settings: ["夜间视力较强", "需要周期性盐浴"], changeNote: "补充生理限制" }
    }
  },
  organization: {
    description: "组织档案",
    scopeArgument: "workId",
    actions: ["list", "get", "create", "update", "history", "restore"],
    create: {
      required: ["name"],
      properties: { name: "组织名称", description: "说明", settings: "设定条目数组", memberIds: "人物 ID 数组" },
      example: { name: "北港议会", description: "控制潮汐航线许可。", settings: ["七席轮值制"], memberIds: [] }
    },
    update: {
      properties: { name: "新名称", description: "新说明", settings: "完整设定数组", memberIds: "完整成员数组", changeNote },
      example: { memberIds: ["character_xxx"], changeNote: "记录林舟临时加入议会调查组" }
    }
  },
  "timeline-track": {
    description: "独立时间轴",
    scopeArgument: "workId",
    actions: ["list", "get", "create", "update", "history", "restore"],
    create: {
      required: ["name"],
      properties: { name: "时间轴名称", description: "说明", sortOrder: "非负整数" },
      example: { name: "北港政变线", description: "记录议会权力更替", sortOrder: 0 }
    },
    update: {
      properties: { name: "新名称", description: "新说明", sortOrder: "非负整数", changeNote },
      example: { description: "补充政变前一周的秘密会议", changeNote: "扩大时间范围" }
    }
  },
  "timeline-event": {
    description: "时间线事件",
    scopeArgument: "workId",
    actions: ["list", "get", "create", "update", "history", "restore"],
    create: {
      required: ["name"],
      properties: {
        name: "事件名称",
        trackId: "时间轴 ID 或 null",
        description: "事件说明",
        eventType: "事件类型",
        timeLabel: "展示时间",
        timeSort: "数值排序或 null",
        chapterIds: "关联章节 ID 数组",
        participantIds: "参与人物 ID 数组",
        location: "地点",
        causes: "原因数组",
        impactScope: "personal | organization | regional | world | galaxy",
        evidence: "证据数组",
        status: "candidate | pending | confirmed | deprecated"
      },
      example: { name: "潮门关闭", timeLabel: "星历 412 年雨季", chapterIds: ["chapter_xxx"], participantIds: [], impactScope: "regional", status: "confirmed" }
    },
    update: {
      properties: { name: "新名称", trackId: "时间轴 ID 或 null", description: "说明", eventType: "类型", timeLabel: "时间标签", timeSort: "排序值或 null", chapterIds: "完整章节数组", participantIds: "完整人物数组", location: "地点", causes: "原因数组", impactScope: "影响范围", evidence: "证据数组", status: "状态", changeNote },
      example: { causes: ["议会封锁令", "外海舰队逼近"], changeNote: "补充事件因果" }
    }
  },
  relationship: {
    description: "人物关系",
    scopeArgument: "workId",
    actions: ["list", "get", "create", "update", "history", "restore"],
    create: {
      required: ["fromCharacterId", "toCharacterId", "category"],
      properties: {
        fromCharacterId: "起点人物 ID",
        toCharacterId: "终点人物 ID",
        category: "family | social | emotional | conflict | uncertain",
        subtype: "关系子类型",
        keywords: "关键词数组",
        directed: "是否有向",
        currentStatus: "当前状态",
        timeRange: "时间范围对象",
        confidence: "0 到 1",
        evidence: "证据数组",
        confirmationStatus: "pending | confirmed | rejected",
        locked: "是否锁定"
      },
      example: { fromCharacterId: "character_a", toCharacterId: "character_b", category: "conflict", subtype: "政治对手", keywords: ["互相试探"], confidence: 0.8, confirmationStatus: "confirmed" }
    },
    update: {
      properties: { fromCharacterId: "起点人物", toCharacterId: "终点人物", category: "分类", subtype: "子类型", keywords: "完整关键词数组", directed: "是否有向", currentStatus: "状态", timeRange: "时间对象", confidence: "0 到 1", evidence: "证据数组", confirmationStatus: "确认状态", locked: "锁定状态", changeNote },
      example: { currentStatus: "暂时结盟", confidence: 0.95, changeNote: "同步第六章谈判结果" }
    }
  },
  foreshadow: {
    description: "伏笔与出现点",
    scopeArgument: "workId",
    actions: ["list", "get", "create", "update", "history", "restore"],
    create: {
      required: ["title"],
      properties: {
        title: "伏笔标题",
        description: "说明",
        status: "planned | planted | resolved | abandoned",
        importance: "low | medium | high",
        plannedPayoffChapterId: "计划回收章节 ID 或 null",
        resolutionNote: "回收说明",
        occurrences: "出现点数组；每项包含 chapterId、role(setup|reminder|payoff)、note、evidence"
      },
      example: { title: "旧船票", description: "船票背面的编号指向失踪名单。", status: "planted", importance: "high", occurrences: [{ chapterId: "chapter_xxx", role: "setup", note: "在行李夹层出现" }] }
    },
    update: {
      properties: { title: "新标题", description: "新说明", status: "状态", importance: "重要性", plannedPayoffChapterId: "计划回收章节", resolutionNote: "回收说明", occurrences: "完整替换出现点数组", changeNote },
      example: { status: "resolved", resolutionNote: "第十章确认编号属于姐姐。", changeNote: "记录伏笔回收" }
    }
  },
  "chapter-outline": {
    description: "章节大纲",
    scopeArgument: "chapterId",
    actions: ["list", "get", "create", "update", "history", "restore"],
    create: {
      required: [],
      properties: { goal: "章节目标", conflict: "核心冲突", turningPoint: "转折点", notes: "备注", status: "draft | ready | completed" },
      example: { goal: "让林舟进入议会", conflict: "身份审查暴露伪造船票", turningPoint: "议长认出编号", status: "ready" }
    },
    update: {
      properties: { goal: "章节目标", conflict: "核心冲突", turningPoint: "转折点", notes: "备注", status: "状态", changeNote },
      example: { turningPoint: "议长私下放行并要求交换情报", changeNote: "强化角色主动选择" }
    },
    notes: ["create 与 update 都使用幂等写入；scope 参数是 chapterId。"]
  }
} satisfies Record<CliResourceType, CliResourceDefinition>;
