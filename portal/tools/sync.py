#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Подготовка портала к сборке/запуску.

Что делает скрипт и, главное, чего он НЕ делает:

  НЕ копирует markdown-документы. Тексты (README, SDD, UX-UI-Spec, BRD, брифы,
  INTEGRATIONS, канон, журнал) подключаются в вики через pymdownx.snippets
  напрямую из d:\\Project\\bidzaar — вторых копий не существует в принципе,
  расходиться нечему.

  Копирует только то, что должно попасть в сайт как файл, а не как текст:
    1. OpenAPI-спецификации  → portal/api/specs/          (их читает Swagger UI)
    2. exchange-order.feature → portal/wiki/docs/features/ (ссылка «скачать» и
       ссылка ./exchange-order.feature из docs/features/README.md)
    3. swagger-ui-dist       → portal/api/vendor/          (офлайн Swagger UI)
    4. mermaid.min.js        → portal/wiki/docs/assets/js/ (офлайн диаграммы)
    5. portal/api            → portal/wiki/docs/swagger/   (чтобы собранный сайт
       раздавал вики и Swagger UI одним статическим деревом)

Всё перечисленное перечислено в .gitignore как генерируемое.
Запуск: python tools/sync.py   (из каталога portal/)
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

# The script prints Cyrillic and arrows. On Windows a console inheriting a
# legacy code page (cp1251 under Git Bash, cp866 under cmd) raises
# UnicodeEncodeError on the first such character and takes the whole build down
# with it — the sync itself is fine, only the reporting is not encodable.
# Reconfiguring the streams is cheaper than muting the output.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # pragma: no cover - very old Python
        pass

PORTAL = Path(__file__).resolve().parent.parent      # …/portal
REPO = PORTAL.parent                                  # …/bidzaar
WIKI_DOCS = PORTAL / "wiki" / "docs"
API_DIR = PORTAL / "api"
NODE_MODULES = PORTAL / "node_modules"

OPENAPI_MAIN = REPO / "docs" / "api" / "exchange-orders.openapi.yaml"
OPENAPI_INTEGRATIONS = REPO / "docs" / "api" / "integrations"
FEATURE_FILE = REPO / "docs" / "features" / "exchange-order.feature"

# Документы, которые вики подключает через snippets. Здесь они только
# проверяются на существование — при опечатке в пути mkdocs упал бы позже
# и менее внятно.
SNIPPET_SOURCES = [
    REPO / "docs" / "00-canonical-model.md",
    REPO / "docs" / "SDD.md",
    REPO / "docs" / "UX-UI-Spec.md",
    REPO / "docs" / "BRD.md",
    REPO / "docs" / "Product Context.md",
    REPO / "docs" / "Design Brief.md",
    REPO / "docs" / "System Design Brief.md",
    REPO / "docs" / "API Brief.md",
    REPO / "docs" / "Gherkin Brief.md",
    REPO / "docs" / "api" / "INTEGRATIONS.md",
    REPO / "docs" / "features" / "README.md",
    REPO / "promtlog.md",
]

SWAGGER_ASSETS = [
    "swagger-ui.css",
    "swagger-ui-bundle.js",
    "swagger-ui-standalone-preset.js",
    "oauth2-redirect.html",
]

warnings: list[str] = []
errors: list[str] = []


def log(msg: str) -> None:
    print(f"  {msg}")


def copy_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def check_sources() -> None:
    print("[1/5] Проверка исходных документов")
    missing = [p for p in SNIPPET_SOURCES if not p.exists()]
    for p in missing:
        errors.append(f"нет исходного документа: {p}")
    log(f"найдено {len(SNIPPET_SOURCES) - len(missing)} из {len(SNIPPET_SOURCES)} "
        f"(подключаются через snippets, не копируются)")


def sync_specs() -> None:
    print("[2/5] OpenAPI-спецификации → api/specs/")
    specs = API_DIR / "specs"
    if specs.exists():
        shutil.rmtree(specs)
    if not OPENAPI_MAIN.exists():
        errors.append(f"нет основной спецификации: {OPENAPI_MAIN}")
        return
    copy_file(OPENAPI_MAIN, specs / OPENAPI_MAIN.name)
    count = 1
    if OPENAPI_INTEGRATIONS.is_dir():
        for yaml in sorted(OPENAPI_INTEGRATIONS.glob("*.yaml")):
            copy_file(yaml, specs / "integrations" / yaml.name)
            count += 1
    else:
        errors.append(f"нет каталога контрактов интеграций: {OPENAPI_INTEGRATIONS}")
    log(f"{count} спецификаций")


def sync_feature() -> None:
    print("[3/5] exchange-order.feature → wiki/docs/features/")
    if not FEATURE_FILE.exists():
        errors.append(f"нет файла сценариев: {FEATURE_FILE}")
        return
    copy_file(FEATURE_FILE, WIKI_DOCS / "features" / FEATURE_FILE.name)
    log("raw-файл для ссылки «скачать» готов")


def vendor_assets() -> None:
    print("[4/5] Вендоринг Swagger UI и Mermaid из node_modules/")

    # --- Swagger UI ---
    swagger_src = NODE_MODULES / "swagger-ui-dist"
    vendor = API_DIR / "vendor"
    if swagger_src.is_dir():
        if vendor.exists():
            shutil.rmtree(vendor)
        for name in SWAGGER_ASSETS:
            src = swagger_src / name
            if src.exists():
                copy_file(src, vendor / name)
            else:
                warnings.append(f"в swagger-ui-dist нет файла {name}")
        for extra in ("LICENSE", "package.json"):
            if (swagger_src / extra).exists():
                copy_file(swagger_src / extra, vendor / extra)
        log("swagger-ui-dist: локальная копия собрана (офлайн-режим доступен)")
    else:
        warnings.append(
            "не найден node_modules/swagger-ui-dist — страница Swagger UI будет "
            "грузиться с unpkg.com (нужен интернет). Лечится: npm install в portal/"
        )
        log("swagger-ui-dist: НЕТ, будет откат на CDN")

    # --- Mermaid ---
    # Material грузит mermaid с unpkg.com только если window.mermaid не задан,
    # поэтому локальный файл автоматически отключает обращение к CDN.
    mermaid_src = NODE_MODULES / "mermaid" / "dist" / "mermaid.min.js"
    mermaid_dst = WIKI_DOCS / "assets" / "javascripts" / "mermaid.min.js"
    if mermaid_src.exists():
        copy_file(mermaid_src, mermaid_dst)
        log(f"mermaid: локальная копия {mermaid_src.stat().st_size // 1024} КБ")
    else:
        # Файл всё равно должен существовать: он объявлен в extra_javascript,
        # иначе mkdocs выдаст warning о недостающем ресурсе. Пустая заглушка
        # оставляет window.mermaid неопределённым → Material сам сходит на CDN.
        mermaid_dst.parent.mkdir(parents=True, exist_ok=True)
        mermaid_dst.write_text(
            "/* Заглушка: node_modules/mermaid не установлен.\n"
            "   Material загрузит Mermaid с unpkg.com — нужен интернет.\n"
            "   Лечится: npm install в каталоге portal/ и npm run sync. */\n",
            encoding="utf-8",
        )
        warnings.append(
            "не найден node_modules/mermaid — диаграммы будут грузиться с "
            "unpkg.com (нужен интернет). Лечится: npm install в portal/"
        )
        log("mermaid: НЕТ, будет откат на CDN")


def sync_swagger_into_wiki() -> None:
    """Swagger UI кладём внутрь docs_dir вики, чтобы собранный портал был одним
    статическим деревом: вики в корне, Swagger UI в /swagger/. Относительные
    ссылки между ними работают и локально, и под любым доменом."""
    print("[5/5] api/ → wiki/docs/swagger/")
    dst = WIKI_DOCS / "swagger"
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(API_DIR, dst)
    # Favicon у портала один: берём из ассетов вики.
    favicon = WIKI_DOCS / "assets" / "favicon.svg"
    if favicon.exists():
        copy_file(favicon, API_DIR / "favicon.svg")
        copy_file(favicon, dst / "favicon.svg")
    size = sum(f.stat().st_size for f in dst.rglob("*") if f.is_file())
    log(f"скопировано {size // 1024 // 1024} МБ (спецификации + Swagger UI)")


def main() -> int:
    print(f"sync: репозиторий {REPO}")
    check_sources()
    sync_specs()
    sync_feature()
    vendor_assets()
    sync_swagger_into_wiki()

    print()
    for w in warnings:
        print(f"  ВНИМАНИЕ: {w}")
    for e in errors:
        print(f"  ОШИБКА:   {e}")
    if errors:
        print("\nsync: не выполнен")
        return 1
    print("sync: готово" + (" (с предупреждениями)" if warnings else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
