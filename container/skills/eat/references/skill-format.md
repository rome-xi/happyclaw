# Skill 格式规范

## 目录结构

```
container/skills/{skill-name}/
  SKILL.md              # 必须：技能定义文件
  scripts/              # 可选：脚本文件
  references/           # 可选：参考文档
```

## SKILL.md 格式

```markdown
---
name: skill-name
description: 一句话描述。用于 Agent 判断何时激活此 skill。
allowed-tools: Bash(script.sh:*), Bash(tool.py:*)
user-invocable: true    # 可选：设为 true 则用户可通过 /skill-name 主动调用
---

# 标题

正文内容：使用说明、命令示例、注意事项等。
Agent 激活 skill 后会读取此文件作为上下文。
```

## frontmatter 字段

| 字段 | 必须 | 说明 |
|------|------|------|
| `name` | 是 | skill 名称，用作标识符 |
| `description` | 是 | 触发描述。Agent 根据此字段判断是否激活 |
| `allowed-tools` | 否 | 允许的工具列表，限制 skill 的操作范围 |
| `user-invocable` | 否 | 用户可主动通过斜杠命令调用 |

## 安装位置

- **项目级**：`container/skills/`（自动挂载到所有容器）
- **用户级**：`~/.claude/skills/`（通过 `install_skill` MCP 工具安装）

项目级 skill 随 HappyClaw 部署自动生效，无需重建镜像。
