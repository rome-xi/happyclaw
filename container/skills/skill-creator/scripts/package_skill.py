#!/usr/bin/env python3
"""
Skill 打包工具 — 将 skill 目录打包为 .skill 文件（zip 格式）

Usage:
    package_skill.py <path/to/skill-folder> [output-directory]
"""

import sys
import zipfile
from pathlib import Path

# 将 scripts/ 目录加入搜索路径，以便导入 validate_skill
sys.path.insert(0, str(Path(__file__).parent))
from validate_skill import validate_skill


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def package_skill(skill_path, output_dir=None):
    skill_path = Path(skill_path).resolve()

    if not skill_path.exists():
        print(f"[ERROR] Skill 目录不存在: {skill_path}")
        return None
    if not skill_path.is_dir():
        print(f"[ERROR] 路径不是目录: {skill_path}")
        return None

    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        print(f"[ERROR] SKILL.md 不存在: {skill_path}")
        return None

    print("校验 skill...")
    valid, message = validate_skill(skill_path)
    if not valid:
        print(f"[ERROR] 校验失败: {message}")
        return None
    print(f"[OK] {message}\n")

    skill_name = skill_path.name
    if output_dir:
        output_path = Path(output_dir).resolve()
        output_path.mkdir(parents=True, exist_ok=True)
    else:
        output_path = Path.cwd()

    skill_filename = output_path / f"{skill_name}.skill"
    EXCLUDED_DIRS = {".git", ".svn", ".hg", "__pycache__", "node_modules"}

    try:
        with zipfile.ZipFile(skill_filename, "w", zipfile.ZIP_DEFLATED) as zipf:
            for file_path in skill_path.rglob("*"):
                if file_path.is_symlink():
                    print(f"[WARN] 跳过符号链接: {file_path}")
                    continue

                rel_parts = file_path.relative_to(skill_path).parts
                if any(part in EXCLUDED_DIRS for part in rel_parts):
                    continue

                if file_path.is_file():
                    resolved_file = file_path.resolve()
                    if not _is_within(resolved_file, skill_path):
                        print(f"[ERROR] 文件逃逸出 skill 根目录: {file_path}")
                        return None
                    if resolved_file == skill_filename.resolve():
                        continue

                    arcname = Path(skill_name) / file_path.relative_to(skill_path)
                    zipf.write(file_path, arcname)
                    print(f"  Added: {arcname}")

        print(f"\n[OK] 打包完成: {skill_filename}")
        return skill_filename

    except Exception as e:
        print(f"[ERROR] 打包失败: {e}")
        return None


def main():
    if len(sys.argv) < 2:
        print("Usage: package_skill.py <path/to/skill-folder> [output-directory]")
        sys.exit(1)

    skill_path = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else None

    print(f"打包 skill: {skill_path}")
    if output_dir:
        print(f"   输出目录: {output_dir}")
    print()

    result = package_skill(skill_path, output_dir)
    sys.exit(0 if result else 1)


if __name__ == "__main__":
    main()
