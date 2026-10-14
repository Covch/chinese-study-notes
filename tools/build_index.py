#!/usr/bin/env python3
"""Пересборка cards/index.json по файлам cards/*.md.

Только стандартная библиотека, без сторонних пакетов.

Порядок карточек: сначала пути, уже известные из текущего index.json (порядок
добавления сохраняется), затем новые файлы в алфавитном порядке имён.

Запуск:
    python3 tools/build_index.py
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS_DIR = os.path.join(ROOT, "cards")
INDEX_PATH = os.path.join(CARDS_DIR, "index.json")
INDEX_VERSION = 1

SECTION_RE = re.compile(r"^##\s+")

# --- frontmatter -----------------------------------------------------------


def strip_quotes(value):
    """Снимает обрамляющие кавычки: "текст" или 'текст'."""
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def parse_frontmatter(text):
    """Простые пары `key: value` между --- в начале файла."""
    meta = {}
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    lines = text.split("\n")

    if not lines or lines[0].strip() != "---":
        return meta

    end = -1
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end == -1:
        return meta

    for line in lines[1:end]:
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        if key:
            meta[key] = strip_quotes(value)
    return meta


# --- индекс ----------------------------------------------------------------


def load_existing_paths():
    """Пути из текущего index.json — чтобы сохранить порядок добавления."""
    try:
        with open(INDEX_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return []

    cards = data.get("cards") if isinstance(data, dict) else None
    if not isinstance(cards, list):
        return []

    paths = []
    for card in cards:
        if isinstance(card, dict) and isinstance(card.get("path"), str):
            paths.append(card["path"])
    return paths


def build_entry(path):
    """Читает md-файл и собирает элемент индекса."""
    with open(os.path.join(ROOT, path), encoding="utf-8") as handle:
        meta = parse_frontmatter(handle.read())

    lesson_raw = meta.get("lesson", "")
    try:
        lesson = int(lesson_raw)
    except (TypeError, ValueError):
        lesson = lesson_raw

    return {
        "path": path,
        "title": meta.get("title", ""),
        "type": meta.get("type", ""),
        "lesson": lesson,
        "level": meta.get("level", ""),
    }


def collect_paths():
    filenames = sorted(
        name for name in os.listdir(CARDS_DIR)
        if name.endswith(".md") and not name.startswith(".")
    )
    available = {"cards/" + name for name in filenames}

    ordered = []
    seen = set()
    for path in load_existing_paths():
        if path in available and path not in seen:
            ordered.append(path)
            seen.add(path)

    for path in sorted(available - seen):
        ordered.append(path)

    return ordered


def main():
    paths = collect_paths()
    cards = []
    for path in paths:
        try:
            cards.append(build_entry(path))
        except OSError as error:
            print("пропущен %s: %s" % (path, error), file=sys.stderr)

    index = {"version": INDEX_VERSION, "cards": cards}
    with open(INDEX_PATH, "w", encoding="utf-8") as handle:
        json.dump(index, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    print("index.json: %d карточек" % len(cards))
    return 0


if __name__ == "__main__":
    sys.exit(main())
