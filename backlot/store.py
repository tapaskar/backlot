"""Project state: one JSON file per project under BACKLOT_DATA_DIR."""
from __future__ import annotations

import json
import re
from pathlib import Path

from pydantic import BaseModel, Field

from . import config
from .schemas import Breakdown, Budget, DirectorNote, ProducerNotes, Schedule, WrapReport


def slugify(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return s[:40] or "untitled"


class DayRecord(BaseModel):
    day: int
    simulation: dict
    director: DirectorNote | None = None
    replanned: bool = False


class Project(BaseModel):
    slug: str
    title: str
    script: str
    breakdown: Breakdown | None = None
    schedule: Schedule | None = None
    budget: Budget | None = None
    producer_notes: ProducerNotes | None = None
    dashboard: dict = Field(default_factory=dict)
    days: list[DayRecord] = Field(default_factory=list)
    completed: list[int] = Field(default_factory=list)
    spent: float = 0.0
    wrap: WrapReport | None = None
    status: str = "draft"          # draft -> greenlit -> shooting -> wrapped

    @property
    def next_day(self) -> int:
        return len(self.days) + 1


class Store:
    def __init__(self, root: Path | None = None):
        self.root = Path(root or config.DATA_DIR)
        self.root.mkdir(parents=True, exist_ok=True)
        self._cache: dict[str, Project] = {}

    def _path(self, slug: str) -> Path:
        return self.root / f"{slug}.json"

    def save(self, p: Project) -> Project:
        self._cache[p.slug] = p
        self._path(p.slug).write_text(p.model_dump_json(indent=1))
        return p

    def get(self, slug: str) -> Project | None:
        if slug in self._cache:
            return self._cache[slug]
        f = self._path(slug)
        if not f.exists():
            return None
        p = Project.model_validate_json(f.read_text())
        self._cache[slug] = p
        return p

    def list(self) -> list[dict]:
        out = []
        for f in sorted(self.root.glob("*.json")):
            p = self.get(f.stem)
            if p:
                out.append(dict(slug=p.slug, title=p.title, status=p.status, days=len(p.days)))
        return out

    def create(self, title: str, script: str) -> Project:
        slug = slugify(title)
        i, base = 2, slug
        while self._path(slug).exists():
            slug = f"{base}-{i}"; i += 1
        return self.save(Project(slug=slug, title=title, script=script))


store = Store()
