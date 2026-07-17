# 协作开发规范

感谢你参与叙界（Scriverse）的开发。提交代码前，请先阅读并遵守以下协作约定。

## 分支策略

- `main` 是稳定发布分支，不用于日常功能开发。
- `develop` 是日常开发和功能集成分支，项目维护者的日常开发也以该分支为基础。
- 所有协作者的 Pull Request 必须以 `develop` 作为目标分支。除项目维护者发起的版本发布合并外，不接受以 `main` 为目标的 Pull Request。
- 功能、修复和文档变更应从最新的 `develop` 派生独立分支，建议使用 `feat/`、`fix/`、`docs/`、`refactor/` 等前缀。

开始开发前：

```bash
git switch develop
git pull --ff-only origin develop
git switch -c feat/short-description
```

提交 Pull Request 时，请确认仓库页面显示的目标分支为：

```text
base: develop <- compare: your-branch
```

## 提交要求

- 一个提交只处理一个独立功能或问题，不混入无关改动。
- Commit message 使用 Angular Commit Message 规范：`<type>(<scope>): <subject>`。
- `subject` 使用英文祈使语气、小写开头且不加句号。
- 提交前运行与改动直接相关的测试，并执行 `git diff --check`。
- 不得提交 `.data/`、密钥、凭据、真实用户数据、临时文件或本地测试产物。

示例：

```text
feat(characters): support custom attributes
fix(auth): reject expired sessions
docs(project): clarify develop workflow
```

## Pull Request 要求

Pull Request 应包含：

- 变更背景和目标。
- 主要实现内容。
- 已执行的测试及结果。
- 数据库迁移、兼容性、安全或部署影响；如无影响也请明确说明。
- 关联的 Issue；没有关联 Issue 时可省略。

请保持 Pull Request 聚焦单一问题。尚未完成时可创建 Draft Pull Request，完成实现、测试和自查后再标记为可审查。

## 合并与发布

- 功能和修复先合并到 `develop`，不得绕过 `develop` 直接进入 `main`。
- `develop` 达到发布条件后，由项目维护者发起从 `develop` 到 `main` 的发布合并。
- 紧急修复如需例外处理，必须由项目维护者明确确认，并在完成后同步回 `develop`。
