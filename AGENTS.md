# AGENTS.md

本文件适用于整个仓库。所有参与本项目的 AI Agent 和开发者都必须遵循以下约定；子目录如有更具体的 `AGENTS.md`，以更具体的规则为补充。

## 1. 项目概览

叙界（Scriverse）是面向长篇小说创作的本地 AI 工作台。系统集中管理作品、分卷、章节、角色、种族、组织、世界设定、时间线、人物关系、大纲伏笔、AI 对话及其版本历史，并支持多用户协作和作品级访问权限。

### 技术栈

- 运行时：Node.js `>= 22.5.0`，ES Module。
- 后端：TypeScript、Express 5、Zod。
- 数据库：Node.js 原生 SQLite，默认数据库为 `.data/novel.db`，启用外键、WAL 和事务。
- 前端：原生 HTML、CSS、JavaScript，不使用前端框架。
- 文件导入：Multer、Mammoth，支持 TXT 和 DOCX。
- 测试：Vitest、Supertest，以及针对已启动服务的真实 E2E。

### 目录与模块职责

```text
src/
  server.ts               服务启动、环境变量、运行时安全配置与优雅关闭
  app.ts                  Express 应用、API 路由、Zod 输入校验和静态资源入口
  database.ts             SQLite 封装、表结构、迁移、事务与中断恢复
  store.ts                作品领域数据访问、业务写入、审计与版本记录
  user-auth.ts            注册登录、会话、用户角色和作品访问权限
  request-context.ts      当前请求操作者上下文，用于审计和历史归属
  security.ts             安全响应头、部署网关、限速、同源校验和 SSRF 防护
  credential-vault.ts     AI 供应商密钥加密与解密
  ai.ts                   AI 供应商调用、上下文组装、任务编排和流式输出
  parser.ts               小说文本、分卷和章节结构解析
  import-security.ts      TXT/DOCX 解压文本的注入与危险内容检查
  domain.ts               公共领域类型和枚举
  errors.ts               统一业务错误
  utils.ts                通用工具函数
  public/
    index.html            单页应用骨架、对话框和语义结构
    app.js                前端状态、路由、API 调用和主要交互编排
    styles.css            全局设计系统和响应式布局
    relationship-graph.js 人物关系图与银河图渲染、交互和局部物理计算
    *.js                  可独立测试的前端纯逻辑模块
tests/
  unit/                   纯函数、解析、迁移、安全和前端逻辑单元测试
  integration/            API、SQLite、权限和业务数据集成测试
  system/                 静态资源和完整作者流程测试
  e2e/                    针对真实运行服务的端到端测试
```

### 核心数据流

1. 浏览器端 `src/public/app.js` 调用 `/api/*`。
2. `src/app.ts` 依次执行安全中间件、会话认证、作品授权和 Zod 输入校验。
3. `Store`、`UserAuthService` 或 `AiManager` 执行业务逻辑。
4. `Database` 通过预编译参数绑定访问 SQLite；跨表写入必须放在事务中。
5. 所有需要追踪的写操作必须记录当前用户、审计日志及对应版本历史。

### 运行与数据边界

- 开发服务默认运行在 `http://127.0.0.1:13210`。
- `npm run dev` 启动监听模式；`npm run build && npm start` 启动生产构建。
- `.data/` 包含真实数据库和密钥，不得提交、删除、覆盖或用于破坏性测试。
- `dist/` 是构建产物，不直接编辑。
- 禁止读取、修改或删除工作区以外的文件，除非用户明确授权且任务确实需要。

## 2. 编程规范

### 通用要求

- 默认使用中文沟通；代码注释使用中文；运行日志使用英文。
- 新增的代码、日志、注释和文档中禁止使用 Emoji。既有 Emoji 不得无关删除或修改。
- 修改必须最小化，只处理当前问题，不顺手重构无关模块。
- 工作区可能存在用户未提交的改动。开始前必须检查 `git status --short`，保留所有无关改动，不覆盖、不回滚、不混入当前提交。
- 不使用 `git reset --hard`、`git checkout --` 等破坏性命令，除非用户明确要求。
- 临时脚本、截图、测试数据和说明文档在任务结束前清理；永久回归测试应保留。
- 默认不新增说明文档。用户明确要求文档时，默认放在 `.ai-docs/` 且不得提交；`README.md`、`AGENTS.md` 等用户明确指定的仓库文档除外。

### TypeScript 与 JavaScript

- 后端保持 TypeScript 严格模式，遵循 `NodeNext` 模块解析和 `.js` 导入后缀约定。
- 优先使用明确类型，禁止用 `any` 绕过类型检查；外部输入先视为 `unknown`，经 Zod 或显式守卫校验后再使用。
- API 输入必须设置长度、数量和枚举上限；对象输入优先使用 `.strict()`，防止静默接收未知字段。
- API 成功响应沿用 `{ data: value }` 结构；业务异常使用统一 `AppError`，不得把内部堆栈、SQL 或密钥返回给客户端。
- 前端复杂算法应拆成无 DOM 依赖的纯函数模块，并在 `tests/unit/` 中覆盖。
- 所有插入 HTML 的用户数据必须经过 `esc` 或等价转义；Markdown 只能通过项目已有的安全渲染器输出。
- 修改静态资源后更新 `index.html` 或相关 import 中的缓存版本参数，并同步更新对应测试断言。

### 数据库与版本记录

- SQL 必须使用 `?` 参数绑定。禁止把用户输入拼接进 SQL；动态表名、字段名和排序片段只能来自服务端受控枚举。
- 多表写入、批量替换、版本创建和审计写入必须使用事务，失败时完整回滚。
- 新增表或字段必须通过向前兼容的迁移实现，不能假设现有数据库为空，不能删除已有数据。
- 作品正文、角色、种族、组织、时间线、关系、设定、大纲和伏笔等可编辑实体必须保留版本记录、操作者和回滚能力。
- 新的写接口必须校验用户会话、CSRF、作品权限和对象归属，不能只依赖前端隐藏按钮。

### 安全要求

- 不得削弱现有 CSP、安全响应头、同源校验、认证限速、API 限速和作品级授权。
- AI 供应商地址继续经过 SSRF 校验；密钥只能由 `CredentialVault` 处理，不得写入日志、响应或测试快照。
- TXT/DOCX 导入必须经过文件大小、扩展名、解压后文本长度和 `import-security.ts` 检查，防止 HTML/JavaScript 注入及压缩炸弹。
- 上传内容只能以项目允许的纯文本或受控图片形式处理，不得直接执行或插入原始 HTML。
- 涉及认证、权限、导入、SQL、文件和网络请求的修改，必须增加越权或恶意输入测试。

### 前端与交互

- 沿用现有 CSS 变量、按钮、卡片、对话框和明暗主题，不创建风格孤立的控件。
- 交互元素必须使用正确的语义标签、可访问名称、键盘行为和必要的 ARIA 状态。
- 图形、拖拽和动画优先局部更新，避免每一帧重建整棵 DOM 或整张图。
- 修复浏览器评论时必须针对用户选中的元素验证，不能只凭源码推测。

### Python 约束

- 本项目不是 Python 项目；如确需运行 Python，必须使用 `uv run python`，安装依赖使用 `uv add`，禁止直接使用 `python`、`python3` 或 `pip`。
- 修改既有 Python 文件时不得改变历史代码缩进，不得删除历史注释。

## 3. Git 协作与 Commit 规范

### 分支与 PR

- `main` 是稳定发布分支，不用于日常开发。
- `develop` 是日常开发和功能集成分支；开始新任务前应切换到最新的 `develop`。
- 功能、修复和文档变更应从 `develop` 派生分支，所有协作者的 PR 必须以 `develop` 为目标分支。
- 只有项目维护者发起的版本发布合并可以从 `develop` 进入 `main`，不得绕过 `develop` 直接提交功能或修复。
- **所有变更必须先合入 `develop`；除项目维护者发起的 `develop` → `main` 版本发布 PR 外，禁止任何功能、修复、文档、CI、构建或维护分支直接向 `main` 发起 PR。**
- 更完整的协作流程见 [协作开发规范](docs/CONTRIBUTING.md)。

### 版本发布

- “发小版本（最后一个版本号+1）”统一解释为发布 SemVer 补丁版本：保持主版本号和次版本号不变，将最后一位加 1，例如 `0.3.2` → `0.3.3`。
- 小版本发布必须先将全部功能、修复和文档提交通过 PR 合入 `develop`，再创建版本号提交并合入 `develop`，随后通过 `develop` → `main` 发布 PR 合入 `main`。
- `main` 合并完成后，必须在该合并提交上创建匹配版本的 Git tag 和正式 GitHub Release，并确认 npm 包与多架构 Docker 镜像发布成功。

### 强制原则

**每完成一个小功能、一个独立缺陷修复或一个可单独验证的改动，都必须立即创建一次独立的 Git commit。禁止累积多个功能后一次性提交。**

- 一个 commit 只包含一个功能点或一个问题的完整闭环。
- 多个浏览器评论必须按顺序逐个修复、逐个测试、逐个提交。
- 提交前只暂存与当前功能直接相关的文件；不得混入用户原有改动或下一个问题的修改。
- 未经用户明确要求不得使用 `git commit --amend`。
- 提交前必须执行 `git diff --check`、查看 `git status --short` 并确认测试通过。
- 提交后再次检查工作区，确认剩余改动均为用户原有改动或后续任务内容。

### Commit message

使用 Angular Commit Message 规范：

```text
<type>(<scope>): <subject>
```

- `feat`：新增用户可见能力。
- `fix`：修复缺陷或错误行为。
- `refactor`：不改变行为的结构调整。
- `perf`：性能优化。
- `test`：仅测试变更。
- `docs`：仅文档变更。
- `build`：构建或依赖变更。
- `ci`：持续集成变更。
- `chore`：其他维护工作。

要求：

- `scope` 使用稳定、简短的模块名，例如 `auth`、`works`、`characters`、`relationships`、`ui`、`security`。
- `subject` 使用英文祈使语气，小写开头，不加句号，准确描述单一改动。
- 破坏性变更必须在正文中写明 `BREAKING CHANGE:`，同时提供迁移方案。

示例：

```text
feat(works): manage access from work details
fix(relationships): align dragged edge geometry
perf(relationships): batch local graph updates
test(auth): cover collaborator permission denial
docs(project): add agent development guide
```

## 4. 测试注意事项

### 单个问题的闭环顺序

1. 先为当前问题确定可复现条件和预期行为。
2. 只实现当前问题，不同时修改下一个问题。
3. 运行与当前改动直接相关的单元测试。
4. 运行对应 API 集成测试或系统测试。
5. 涉及 UI 时，针对已启动服务执行真实浏览器 E2E，验证交互、可见结果和控制台错误。
6. 当前问题全部通过后，立即创建独立 commit。
7. 再开始下一个问题。
8. 所有问题闭环后运行全量冒烟、生产构建和数据库完整性检查。

### 测试命令

```bash
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:system
npm test
npm run build
npm run check
```

真实 E2E 仅对专用测试服务和专用测试数据库运行：

```bash
DATA_DIR=.data/e2e-isolated PORT=13211 npm run dev
E2E_BASE_URL=http://127.0.0.1:13211/api npm run test:e2e:real
```

禁止让会创建、修改或删除记录的 E2E 指向默认 `.data/novel.db`。若只验证当前人工数据页面，应使用只读操作；需要写入时必须先使用工作区内的隔离测试数据库。测试结束后只能清理明确创建的 `.data/e2e-isolated`，不得删除整个 `.data`。

### 分层要求

- 单元测试：覆盖纯函数、边界值、无效输入、状态转换和确定性算法。
- 集成测试：使用 `:memory:` 或临时数据库覆盖 API、权限、事务、审计、版本和外键行为。
- 系统测试：验证静态资源、关键文案、资源缓存版本和完整作者流程。
- 浏览器 E2E：验证真实 DOM、键盘、点击、拖拽、焦点、可访问名称、计算样式和响应式布局；截图只能作为辅助证据，不能代替行为断言。
- 安全测试：至少覆盖未登录、无权限、缺少 CSRF、超长输入、危险上传、SQL 特殊字符和受限网络地址。

### 数据库保护

- 测试前记录目标数据库路径，确认没有误用生产或用户数据库。
- 对真实数据库只执行只读检查：

```bash
sqlite3 -readonly .data/novel.db "PRAGMA integrity_check; PRAGMA foreign_key_check;"
```

- 冒烟测试前后对关键表计数进行比对，确保作品、章节、用户和版本数量没有意外变化。
- 禁止通过删除 `.data/`、重建数据库或清空表来让测试通过。
- 数据库、WAL、SHM 和 `master.key` 必须作为一个整体保护；不得单独移动或删除。

### 完成标准

- 当前问题的复现条件已经消失，并有对应回归测试。
- 类型检查、相关单元测试、相关集成或系统测试、UI E2E 均通过。
- 全部问题完成后，`npm test`、`npm run build`、健康检查和 SQLite 完整性检查通过。
- 临时测试文件和测试数据已清理，工作区外文件未被修改。
- 当前小功能已经使用符合规范的独立 commit 提交。
