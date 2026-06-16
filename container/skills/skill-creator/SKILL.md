---
name: skill-creator
description: Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.
user-invocable: true
---

# Skill Creator

创建、修改、优化 HappyClaw skills。

## Skill 结构

```
skill-name/
├── SKILL.md              # 必须：技能定义（frontmatter + 使用说明）
├── scripts/              # 可选：可执行脚本
├── references/           # 可选：参考文档（Agent 按需加载）
└── assets/               # 可选：输出资源（模板、图片等）
```

### SKILL.md frontmatter

```yaml
---
name: skill-name                    # 必须：hyphen-case
description: 完整的功能描述和触发场景  # 必须：Agent 据此判断是否激活
allowed-tools: Bash(script.sh:*)    # 可选：限制可用工具
user-invocable: true                # 可选：允许 /skill-name 主动调用
---
```

**description 是最重要的字段**，它决定 skill 何时被触发。要写清楚：
- 做什么
- 什么时候用（具体场景、关键词、文件类型）

### 安装位置

| 位置 | 路径 | 生效范围 |
|------|------|---------|
| 项目级 | `container/skills/` | 所有容器自动挂载 |
| 用户级 | `~/.claude/skills/` | 通过 `install_skill` MCP 工具安装 |

## 创建流程

### 1. 理解需求

明确 skill 的使用场景，收集具体例子：
- 用户会怎么描述这个需求？
- 需要什么输入/输出？
- 有哪些边界情况？

### 2. 规划内容

分析每个场景，确定需要哪些可复用资源：
- 重复写的代码 -> `scripts/`
- 需要参考的文档 -> `references/`
- 模板/素材文件 -> `assets/`

### 3. 初始化

用 init_skill.py 创建模板：

```bash
python scripts/init_skill.py <name> --path <dir> [--resources scripts,references] [--examples]
```

项目级 skill 放在 `container/skills/`：
```bash
python scripts/init_skill.py my-skill --path container/skills --resources scripts,references
```

### 4. 实现

编辑 SKILL.md 和资源文件。核心原则：

- **精简**：上下文是公共资源，只写 Agent 不知道的信息
- **提炼**：不要照搬大段文本，提取关键可操作内容
- **渐进加载**：SKILL.md 控制在 500 行内，详细内容放 `references/`
- **测试脚本**：scripts/ 里的脚本必须实际运行验证

设计模式参考：[references/workflows.md](references/workflows.md)

### 5. 校验

```bash
python scripts/validate_skill.py <path/to/skill>
```

检查 frontmatter 格式、必要字段、命名规范。

### 6. 打包（可选）

```bash
python scripts/package_skill.py <path/to/skill> [output-dir]
```

生成 `.skill` 文件（zip 格式），可分发安装。

### 7. 迭代

实际使用后根据效果优化：
- description 触发不准确 -> 调整关键词和场景描述
- 执行效果不好 -> 补充步骤说明或脚本
- 上下文太大 -> 拆分到 references/

## 优化已有 Skill

### 触发准确性

1. 收集应该触发和不应该触发的样例
2. 调整 description 的关键词覆盖
3. 确保不和其他 skill 的触发词冲突

### 性能优化

1. 检查 SKILL.md 行数，超 500 行就拆分
2. 大段参考内容移到 references/
3. 重复代码提取为 scripts/

## 注意事项

- 不要创建多余的文档文件（README.md、CHANGELOG.md 等）
- Skill 内容面向 AI Agent，不是面向人类用户
- 一个知识点只存一个地方，避免重复
- 优先扩展已有 skill 而非创建新 skill
