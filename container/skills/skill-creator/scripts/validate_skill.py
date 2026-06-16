#!/usr/bin/env python3
"""
Skill 校验工具 — 检查 skill 目录结构和 frontmatter 格式

Usage:
    validate_skill.py <skill_directory>
"""

import re
import sys
from pathlib import Path
from typing import Optional

try:
    import yaml
except ModuleNotFoundError:
    yaml = None

MAX_SKILL_NAME_LENGTH = 64


def _extract_frontmatter(content: str) -> Optional[str]:
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[1:i])
    return None


def _parse_simple_frontmatter(frontmatter_text: str) -> Optional[dict]:
    parsed = {}
    current_key = None
    for raw_line in frontmatter_text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        is_indented = raw_line[:1].isspace()
        if is_indented:
            if current_key is None:
                return None
            current_value = parsed[current_key]
            parsed[current_key] = (
                f"{current_value}\n{stripped}" if current_value else stripped
            )
            continue
        if ":" not in stripped:
            return None
        key, value = stripped.split(":", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            return None
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        parsed[key] = value
        current_key = key
    return parsed


def validate_skill(skill_path):
    """校验 skill 目录，返回 (valid: bool, message: str)"""
    skill_path = Path(skill_path)

    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return False, "SKILL.md 不存在"

    try:
        content = skill_md.read_text(encoding="utf-8")
    except OSError as e:
        return False, f"无法读取 SKILL.md: {e}"

    frontmatter_text = _extract_frontmatter(content)
    if frontmatter_text is None:
        return False, "frontmatter 格式无效（缺少 --- 分隔符）"

    if yaml is not None:
        try:
            frontmatter = yaml.safe_load(frontmatter_text)
            if not isinstance(frontmatter, dict):
                return False, "frontmatter 必须是 YAML 字典"
        except yaml.YAMLError as e:
            return False, f"YAML 解析失败: {e}"
    else:
        frontmatter = _parse_simple_frontmatter(frontmatter_text)
        if frontmatter is None:
            return False, "frontmatter 解析失败（未安装 PyYAML 时仅支持简单 key: value）"

    # HappyClaw 支持的 frontmatter 字段
    allowed_properties = {
        "name", "description",
        "allowed-tools", "user-invocable",
        "license", "metadata",
    }

    unexpected_keys = set(frontmatter.keys()) - allowed_properties
    if unexpected_keys:
        allowed = ", ".join(sorted(allowed_properties))
        unexpected = ", ".join(sorted(unexpected_keys))
        return False, f"未知字段: {unexpected}（允许: {allowed}）"

    if "name" not in frontmatter:
        return False, "缺少 'name' 字段"
    if "description" not in frontmatter:
        return False, "缺少 'description' 字段"

    name = frontmatter.get("name", "")
    if not isinstance(name, str):
        return False, f"name 必须是字符串，当前类型: {type(name).__name__}"
    name = name.strip()
    if name:
        if not re.match(r"^[a-z0-9-]+$", name):
            return False, f"name '{name}' 必须是 hyphen-case（小写字母、数字、连字符）"
        if name.startswith("-") or name.endswith("-") or "--" in name:
            return False, f"name '{name}' 不能以连字符开头/结尾或包含连续连字符"
        if len(name) > MAX_SKILL_NAME_LENGTH:
            return False, f"name 过长（{len(name)} 字符），最大 {MAX_SKILL_NAME_LENGTH}"

    description = frontmatter.get("description", "")
    if not isinstance(description, str):
        return False, f"description 必须是字符串，当前类型: {type(description).__name__}"
    description = description.strip()
    if description:
        if len(description) > 1024:
            return False, f"description 过长（{len(description)} 字符），最大 1024"

    # 检查 TODO 残留
    if "[TODO:" in description:
        return False, "description 中还有未完成的 [TODO:] 占位符"

    return True, "校验通过"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: validate_skill.py <skill_directory>")
        sys.exit(1)

    valid, message = validate_skill(sys.argv[1])
    print(f"{'[OK]' if valid else '[ERROR]'} {message}")
    sys.exit(0 if valid else 1)
