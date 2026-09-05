"""Deterministic script parser for Fountain-style and plain screenplay text.

Recognises scene headings (INT./EXT./INT/EXT/EST.), character cues (an upper-case
line followed by dialogue) and estimates length in eighths of a page. It does
not try to be clever about props or stunts - that is the breakdown agent's job,
and the agent receives this structure so it cannot invent scenes.
"""
from __future__ import annotations

import re

from .schemas import Breakdown, Scene

HEADING = re.compile(r"^\s*(?:\d+[A-Z]?\s+)?(INT\.?/EXT\.?|EXT\.?/INT\.?|INT\.?|EXT\.?|EST\.?|I/E\.?)\s+(.+?)\s*$", re.I)
TIME_WORDS = ("DAY", "NIGHT", "DAWN", "DUSK", "MORNING", "EVENING", "AFTERNOON", "CONTINUOUS", "LATER", "MAGIC HOUR", "SUNSET", "SUNRISE")
CUE = re.compile(r"^\s*([A-Z][A-Z0-9 .'\-]{1,40}?)(?:\s*\([^)]*\))?\s*$")
NOT_CUE = {"INT", "EXT", "FADE IN", "FADE OUT", "CUT TO", "THE END", "END", "CONTINUED", "TITLE", "SUPER", "MONTAGE"}
LINES_PER_PAGE = 55


def _split_heading(rest: str) -> tuple[str, str]:
    """'RIVERBANK - NIGHT' -> ('RIVERBANK', 'NIGHT'); time defaults to DAY."""
    parts = [p.strip() for p in re.split(r"\s+[-–—]+\s+", rest) if p.strip()]
    if len(parts) >= 2:
        tail = parts[-1].upper()
        for t in TIME_WORDS:
            if t in tail:
                return " - ".join(parts[:-1]).strip().upper(), t
    return rest.strip().upper(), "DAY"


def _int_ext(tag: str) -> str:
    t = tag.upper().replace(".", "")
    if "/" in t:
        return "INT/EXT"
    return "INT" if t.startswith("INT") else "EXT"


def parse_script(text: str, title: str | None = None) -> Breakdown:
    lines = text.splitlines()
    scenes: list[Scene] = []
    cur: dict | None = None
    body: list[str] = []

    def flush():
        if cur is None:
            return
        n_lines = sum(1 for l in body if l.strip())
        eighths = max(1, round(n_lines / LINES_PER_PAGE * 8))
        cast = []
        for i, l in enumerate(body):
            m = CUE.match(l)
            if not m:
                continue
            name = m.group(1).strip()
            if name in NOT_CUE or len(name) < 2 or name.endswith(":"):
                continue
            nxt = body[i + 1].strip() if i + 1 < len(body) else ""
            if nxt and not nxt.isupper() and name not in cast:
                cast.append(name)
        scenes.append(Scene(number=len(scenes) + 1, heading=cur["heading"], int_ext=cur["int_ext"],
                            location=cur["location"], time_of_day=cur["time"], eighths=eighths,
                            cast=cast, synopsis=" ".join(l.strip() for l in body[:3] if l.strip())[:200]))

    for line in lines:
        m = HEADING.match(line)
        if m and not CUE.match(line.strip()) or (m and m.group(1).upper().rstrip(".") in ("INT", "EXT", "EST", "I/E", "INT/EXT", "EXT/INT")):
            flush()
            loc, tod = _split_heading(m.group(2))
            cur = dict(heading=line.strip(), int_ext=_int_ext(m.group(1)), location=loc, time=tod)
            body = []
        elif cur is not None:
            body.append(line)
    flush()

    if title is None:
        for l in lines:
            s = l.strip()
            if s.lower().startswith("title:"):
                title = s.split(":", 1)[1].strip()
                break
        title = title or "Untitled"
    chars, locs = [], []
    for s in scenes:
        for c in s.cast:
            if c not in chars:
                chars.append(c)
        if s.location not in locs:
            locs.append(s.location)
    return Breakdown(title=title, scenes=scenes, characters=chars, locations=locs)
