#!/usr/bin/env python3
"""
Skill 初始化工具 — 创建新 skill 目录模板

Usage:
    init_skill.py <skill-name> --path <path> [--resources scripts,references,assets] [--examples]

Examples:
    init_skill.py my-skill --path /path/to/container/skills
    init_skill.py my-skill --path /path/to/container/skills --resources scripts,references
"""

import argparse
import re
import sys
from pathlib import Path

MAX_SKILL_NAME_LENGTH = 64
ALLOWED_RESOURCES = {"scripts", "references", "assets"}

SKILL_TEMPLATE = """---
name: {skill_name}
description: [TODO: 完整描述 skill 的功能和触发场景。包含具体的使用场景、文件类型或任务类型。]
---

# {skill_title}

## 概述

[TODO: 1-2 句话说明这个 skill 做什么]

## 使用场景

[TODO: 列出触发此 skill 的典型场景]

## 工作流程

[TODO: 描述 skill 的执行步骤。常见结构：

**1. 流程型**（适合有序步骤）
- 结构：## 概述 -> ## 步骤 1 -> ## 步骤 2...

**2. 任务型**（适合工具集合）
- 结构：## 概述 -> ## 快速开始 -> ## 任务 A -> ## 任务 B...

**3. 参考型**（适合规范/标准）
- 结构：## 概述 -> ## 规范 -> ## 用法...

完成后删除此提示段落。]

## 资源

如无需要可删除此段。

### scripts/
可执行脚本，用于需要确定性可靠性的操作。

### references/
参考文档，Agent 按需加载到上下文中。

### assets/
输出使用的文件（模板、图片等），不加载到上下文。
"""

EXAMPLE_SCRIPT = '''#!/usr/bin/env python3
"""
{skill_name} 示例脚本

替换为实际实现或按需删除。
"""

def main():
    print("This is an example script for {skill_name}")

if __name__ == "__main__":
    main()
'''

EXAMPLE_REFERENCE = """# {skill_title} 参考文档

替换为实际参考内容或按需删除。

## 适用场景

- API 文档
- 详细工作流指南
- 数据库 Schema
- 领域知识
"""

EXAMPLE_ASSET = """# 示例资源文件

此占位符代表资源文件存放位置。
替换为实际资源文件（模板、图片、字体等）或按需删除。
"""


def normalize_skill_name(skill_name):
    normalized = skill_name.strip().lower()
    normalized = re.sub(r"[^a-z0-9]+", "-", normalized)
    normalized = normalized.strip("-")
    normalized = re.sub(r"-{2,}", "-", normalized)
    return normalized


def title_case_skill_name(skill_name):
    return " ".join(word.capitalize() for word in skill_name.split("-"))


def parse_resources(raw_resources):
    if not raw_resources:
        return []
    resources = [item.strip() for item in raw_resources.split(",") if item.strip()]
    invalid = sorted({item for item in resources if item not in ALLOWED_RESOURCES})
    if invalid:
        allowed = ", ".join(sorted(ALLOWED_RESOURCES))
        print(f"[ERROR] 未知资源类型: {', '.join(invalid)}")
        print(f"   允许的类型: {allowed}")
        sys.exit(1)
    deduped = []
    seen = set()
    for resource in resources:
        if resource not in seen:
            deduped.append(resource)
            seen.add(resource)
    return deduped


def create_resource_dirs(skill_dir, skill_name, skill_title, resources, include_examples):
    for resource in resources:
        resource_dir = skill_dir / resource
        resource_dir.mkdir(exist_ok=True)
        if resource == "scripts":
            if include_examples:
                example_script = resource_dir / "example.py"
                example_script.write_text(EXAMPLE_SCRIPT.format(skill_name=skill_name))
                example_script.chmod(0o755)
                print("[OK] Created scripts/example.py")
            else:
                print("[OK] Created scripts/")
        elif resource == "references":
            if include_examples:
                example_reference = resource_dir / "reference.md"
                example_reference.write_text(EXAMPLE_REFERENCE.format(skill_title=skill_title))
                print("[OK] Created references/reference.md")
            else:
                print("[OK] Created references/")
        elif resource == "assets":
            if include_examples:
                example_asset = resource_dir / "example_asset.txt"
                example_asset.write_text(EXAMPLE_ASSET)
                print("[OK] Created assets/example_asset.txt")
            else:
                print("[OK] Created assets/")


def init_skill(skill_name, path, resources, include_examples):
    skill_dir = Path(path).resolve() / skill_name

    if skill_dir.exists():
        print(f"[ERROR] Skill 目录已存在: {skill_dir}")
        return None

    try:
        skill_dir.mkdir(parents=True, exist_ok=False)
        print(f"[OK] Created skill directory: {skill_dir}")
    except Exception as e:
        print(f"[ERROR] 创建目录失败: {e}")
        return None

    skill_title = title_case_skill_name(skill_name)
    skill_content = SKILL_TEMPLATE.format(skill_name=skill_name, skill_title=skill_title)

    skill_md_path = skill_dir / "SKILL.md"
    try:
        skill_md_path.write_text(skill_content)
        print("[OK] Created SKILL.md")
    except Exception as e:
        print(f"[ERROR] 创建 SKILL.md 失败: {e}")
        return None

    if resources:
        try:
            create_resource_dirs(skill_dir, skill_name, skill_title, resources, include_examples)
        except Exception as e:
            print(f"[ERROR] 创建资源目录失败: {e}")
            return None

    print(f"\n[OK] Skill '{skill_name}' 初始化完成: {skill_dir}")
    print("\n下一步:")
    print("1. 编辑 SKILL.md，补全 TODO 项和 description")
    if resources:
        if include_examples:
            print("2. 自定义或删除示例文件")
        else:
            print("2. 按需添加脚本/参考/资源文件")
    else:
        print("2. 按需创建 scripts/、references/、assets/ 目录")

    return skill_dir


def main():
    parser = argparse.ArgumentParser(description="创建新 skill 目录模板")
    parser.add_argument("skill_name", help="Skill 名称（自动规范化为 hyphen-case）")
    parser.add_argument("--path", required=True, help="输出目录")
    parser.add_argument("--resources", default="", help="资源目录: scripts,references,assets")
    parser.add_argument("--examples", action="store_true", help="创建示例文件")
    args = parser.parse_args()

    raw_skill_name = args.skill_name
    skill_name = normalize_skill_name(raw_skill_name)
    if not skill_name:
        print("[ERROR] Skill 名称至少包含一个字母或数字")
        sys.exit(1)
    if len(skill_name) > MAX_SKILL_NAME_LENGTH:
        print(f"[ERROR] 名称过长（{len(skill_name)} 字符），最大 {MAX_SKILL_NAME_LENGTH}")
        sys.exit(1)
    if skill_name != raw_skill_name:
        print(f"Note: 名称规范化 '{raw_skill_name}' -> '{skill_name}'")

    resources = parse_resources(args.resources)
    if args.examples and not resources:
        print("[ERROR] --examples 需配合 --resources 使用")
        sys.exit(1)

    print(f"初始化 skill: {skill_name}")
    print(f"   位置: {args.path}")
    if resources:
        print(f"   资源: {', '.join(resources)}")
    print()

    result = init_skill(skill_name, args.path, resources, args.examples)
    sys.exit(0 if result else 1)


if __name__ == "__main__":
    main()
