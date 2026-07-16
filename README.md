<p align="center">
  <a href="https://scriverse.top/">
    <img src="./showcase/public/favicon.svg" alt="叙界 Scriverse" width="96">
  </a>
</p>

<h1 align="center">叙界 Scriverse</h1>

<p align="center">
  面向长篇小说创作的本地 AI 工作台
</p>

<p align="center">
  <a href="README.md">中文</a> | <a href="README.en.md">English</a>
</p>

<p align="center">
  在线演示：<a href="https://scriverse.top/">https://scriverse.top/</a>
</p>

<p align="center">
  <a href="https://scriverse.top/">
    <img src="./showcase/public/scriverse-overview.png" alt="叙界 Scriverse：让宏大的故事，有迹可循" width="100%">
  </a>
</p>

<p align="center">
  叙界是一个面向长篇小说的本地 AI 创作工作台。它把正文、分卷、角色、组织、世界设定、时间线、人物关系、大纲伏笔和 AI 辅助集中在同一个项目中，适合管理大体量、设定密集的小说工程。
</p>

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
| `HOST` | `127.0.0.1` | 监听地址；服务器部署时可设为 `0.0.0.0` |
| `DATA_DIR` | `<项目目录>/.data` | 默认数据目录 |
| `DATABASE_PATH` | `<DATA_DIR>/novel.db` | SQLite 数据库路径 |
| `AI_NOVEL_MASTER_KEY` | 自动生成并保存在 `<DATA_DIR>/master.key` | 加密 AI 供应商密钥的主密钥 |
| `APP_AUTH_USERNAME` | 空 | 可选的部署网关账号；应用内用户系统始终启用 |
| `APP_AUTH_PASSWORD` | 空 | 可选的部署网关密码，至少 12 个字符；必须通过 HTTPS 传输 |
| `APP_TRUST_PROXY` | `false` | 位于可信反向代理后时设为代理跳数（通常为 `1`）或 `true` |
| `APP_ALLOW_PRIVATE_AI_ENDPOINTS` | 开发环境 `true`，生产环境 `false` | 是否允许 AI 供应商连接本机或内网地址；链路本地与云元数据地址始终禁止 |
| `APP_ALLOW_REGISTRATION` | `true` | 设为 `false` 时关闭开放注册（仍允许首次初始化创建管理员）；公网 nginx 反代部署建议关闭 |

自定义示例：

```bash
PORT=13211 DATA_DIR=/path/to/scriverse-data npm run dev
```

服务器部署示例：

```bash
NODE_ENV=production \
HOST=0.0.0.0 \
APP_AUTH_USERNAME=admin \
APP_AUTH_PASSWORD='请替换为足够长的随机密码' \
npm start
```

生产环境必须在可信反向代理后启用 HTTPS。应用首次启动时，第一个注册用户自动成为系统管理员；后续用户为普通用户。可选的 HTTP Basic Auth 仅作为额外部署网关，其凭据只是 Base64 编码，未使用 HTTPS 时不能防止链路窃听。`/api/health` 保持免认证以供探活，业务 API 需要应用内登录。

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
- 项目不包含用户系统；服务器部署使用环境变量配置的单实例 HTTP Basic Auth。生产环境缺少凭据时会拒绝启动。
- 服务默认只监听 `127.0.0.1`。非本机监听同样强制要求鉴权，公网入口必须使用 HTTPS、可信反向代理和防火墙访问控制。
- 应用默认启用 CSP、防点击劫持、MIME 嗅探防护、同源写请求校验、认证失败限速、API 限速、JSON/上传大小限制和 AI 供应商 SSRF 防护。
- SQLite 查询通过 prepared statements 绑定参数；动态 SQL 片段只来自服务端受控枚举，不拼接用户输入。

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

## 🌟 Special Thanks

<p align="center">
  <a href="https://linux.do">
    <img src="showcase/public/linuxdo.png" alt="LINUX DO" width="420" />
  </a>
</p>
<p align="center"><b>学AI，上L站！祝小破站越来越好～</b></p>
