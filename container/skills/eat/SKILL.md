---
name: eat
description: 吸收知识并转化为持久能力。输入任何 URL、文件、代码片段或概念，Agent 会阅读理解后将其转化为可复用的 skill、CLAUDE.md 规则、或 references 参考文档。用于用户说"学一下这个"、"把这个吃掉"、"记住这个用法"等场景。
user-invocable: true
---

# /eat — 知识吸收与能力转化

将外部知识吸收为 Agent 的持久能力。

## 触发场景

- 用户分享 URL / 文件 / 代码片段，要求"学习"或"记住"
- 用户说"吃掉这个"、"把这个学了"、"以后要用这个"
- 发现有价值的技术文档、API 参考、最佳实践

## 工作流程

### 1. 识别输入类型

| 输入 | 获取方式 |
|------|---------|
| URL | WebFetch 或 agent-browser 抓取内容 |
| 本地文件 | Read 工具直接读取 |
| 代码片段 | 从对话上下文提取 |
| 概念/规则 | 从用户描述中理解 |

### 2. 分析并分类

阅读内容后判断最适合的持久化方式：

| 类型 | 持久化目标 | 示例 |
|------|-----------|------|
| **可执行能力** | 新建 skill（`container/skills/{name}/`） | API 集成、CLI 工具包装、自动化流程 |
| **行为规则** | 写入 CLAUDE.md 对应段落 | 编码风格、沟通偏好、项目约定 |
| **参考资料** | 写入现有 skill 的 `references/` 或全局 `references/` | API 文档、协议规范、配置说明 |
| **临时知识** | `memory_append` 日期记忆 | 今日决策、临时方案 |

### 3. 执行转化

根据分类执行对应操作：

#### 创建新 Skill
```
container/skills/{name}/
  SKILL.md          # 技能定义（frontmatter + 使用说明）
  scripts/          # 脚本文件（如有）
  references/       # 参考文档（如有）
```

#### 更新 CLAUDE.md
用 Edit 工具更新 `/workspace/global/CLAUDE.md` 对应段落。

#### 添加参考文档
将提炼后的内容写入相关 skill 的 `references/` 目录。

### 4. 确认与汇报

向用户汇报：
- 吃了什么（一句话概括输入内容）
- 变成了什么（skill / 规则 / 参考文档）
- 存在哪里（具体文件路径）

## 转化原则

- **提炼不照搬**：不要原样复制大段文本，提取关键信息和可操作内容
- **融入已有体系**：优先扩展已有 skill 而非创建新 skill
- **最小化原则**：一个知识点只存一个地方，不重复存储
- **实用优先**：只保留 Agent 实际会用到的内容，跳过背景介绍和营销话术
- **Skill 格式规范**：参考 [references/skill-format.md](references/skill-format.md)
