# 叙界 Scriverse

[中文](README.md) | [English](README.en.md)

叙界是一个面向长篇小说的本地 AI 创作工作台。它把正文、分卷、角色、组织、世界设定、时间线、人物关系、大纲伏笔和 AI 辅助集中在同一个项目中，适合管理大体量、设定密集的小说工程。

## 主要能力

- 作品书架：管理多部作品、封面、作者和简介。
- 正文编辑：分卷与章节树、自动保存、历史版本、行号引用、空行整理和全文检索。
- 章节分类：支持正文、设定、作者的话和其他四种类型。
- 文件导入：导入 TXT 或 DOCX，识别分卷、章节和后记类型。
- 设定库：管理世界设定、角色别名、角色属性与锁定字段。
- 组织系统：维护组织简介、设定列表和成员，一个角色可同时属于多个组织。
- 时间线：以看板方式管理多条大事件时间轨道，支持拆分、合并和排序。
- 人物关系：关系类型、关键词列表、证据与置信度，提供普通关系图和可交互的 3D 银河图。
- 大纲与伏笔：维护章节目标、冲突、转折和伏笔的埋设、提醒与回收。
- AI 创作助手：支持 Markdown 和流式输出，可引用章节行、附加角色与设定上下文。
- AI 任务：结构分析、章节分析、角色抽取、时间线分析、关系分析和一致性检查。
- 供应商管理：兼容 OpenAI Chat Completions 协议，可配置模型、最大输出 Token、并发数和 RPM。
- 安全导出：支持 JSON、TXT 和 Markdown，导出内容不包含 AI 密钥。

## 技术栈

- Node.js 22.5+
- TypeScript
- Express 5
- Node.js SQLite
- 原生 HTML、CSS 和 JavaScript
- Vitest 与 Supertest

## 快速开始

### 环境要求

- Node.js `>= 22.5.0`
- npm

### 安装与开发运行

```bash
git clone git@github.com:musnows/Scriverse.git
cd Scriverse
npm ci
npm run dev
```

默认访问地址：[http://localhost:13210](http://localhost:13210)

### 生产构建

```bash
npm run build
npm start
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `13210` | HTTP 服务端口 |
| `DATA_DIR` | `<项目目录>/.data` | 默认数据目录 |
| `DATABASE_PATH` | `<DATA_DIR>/novel.db` | SQLite 数据库路径 |
| `AI_NOVEL_MASTER_KEY` | 自动生成并保存在 `<DATA_DIR>/master.key` | 加密 AI 供应商密钥的主密钥 |

自定义示例：

```bash
PORT=13211 DATA_DIR=/path/to/scriverse-data npm run dev
```

## AI 供应商配置

1. 启动项目后，点击顶部“AI 管理”进入平台级配置。
2. 新建兼容 OpenAI Chat Completions 的供应商，填写基础地址、API 密钥、并发数、RPM 与最大输出 Token。
3. 为模型填写其支持的上下文总量（Token），再添加模型。
4. 在平台页设置全局系统提示词；它会追加在内置提示词之后。
5. 打开一本作品，在“更多 → AI 设置”中设置该书的追加系统提示词和任务默认模型；书籍提示词会追加在全局提示词之后。

新建供应商默认最大并发请求数和 RPM 均为 `10`，默认最大输出 Token 为 `32000`；新建模型默认上下文容量为 `128000` Token。侧栏对话框会显示当前请求的上下文用量圆环。

## 数据与安全

- 数据默认保存在 `.data/novel.db`。
- AI 供应商密钥经加密后存储，主密钥默认位于 `.data/master.key`。
- 备份或迁移时，请同时保存数据库和主密钥；丢失主密钥后无法解密已保存的供应商密钥。
- 项目当前定位为本地工作台，没有内置用户认证。不要在未配置反向代理认证和网络访问控制的情况下直接暴露到公网。

## 测试

```bash
# 类型检查
npm run typecheck

# 全部 Vitest 测试
npm test

# 单元、集成和系统测试
npm run test:unit
npm run test:integration
npm run test:system

# 针对已启动服务的真实 E2E 测试
npm run test:e2e:real

# 类型检查、全部测试和生产构建
npm run check
```

`test:e2e:real` 默认访问 `http://127.0.0.1:13210/api`。如果服务运行在其他地址，可以设置 `E2E_BASE_URL`：

```bash
E2E_BASE_URL=http://127.0.0.1:13211/api npm run test:e2e:real
```

## 项目结构

```text
src/
  ai.ts                  AI 调用、上下文构建与任务编排
  app.ts                 Express API 与静态界面入口
  database.ts            SQLite 表结构与迁移
  parser.ts              TXT/DOCX 小说结构解析
  server.ts              服务启动与关闭
  store.ts               业务数据存取
  public/                浏览器端界面与可视化
tests/
  unit/                  单元测试
  integration/           API 与数据集成测试
  system/                完整作者流程测试
  e2e/                   针对运行服务的端到端测试
```

## 健康检查

```bash
curl http://127.0.0.1:13210/api/health
```

正常响应示例：

```json
{
  "data": {
    "status": "ok",
    "version": "0.1.0",
    "protocol": "openai-chat-completions"
  }
}
```

## 项目状态

当前为 MVP 版本，接口和数据结构仍可能调整。升级前请备份 `.data` 目录。
