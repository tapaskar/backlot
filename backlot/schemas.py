"""Typed contracts shared by the parser, the planners, the agents and the web app.

Everything an agent returns is one of these models, so the deterministic code
never has to trust free text.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Scene(BaseModel):
    number: int
    heading: str = Field(description="Slug line as written, e.g. 'EXT. RIVERBANK - NIGHT'")
    int_ext: Literal["INT", "EXT", "INT/EXT"] = "EXT"
    location: str
    time_of_day: str = "DAY"
    eighths: int = Field(ge=1, description="Script length in eighths of a page")
    cast: list[str] = Field(default_factory=list)
    props: list[str] = Field(default_factory=list)
    synopsis: str = ""
    notes: str = Field(default="", description="Special requirements: stunts, animals, vehicles, VFX, minors, water")


class Breakdown(BaseModel):
    title: str
    logline: str = ""
    scenes: list[Scene]
    characters: list[str] = Field(default_factory=list)
    locations: list[str] = Field(default_factory=list)


class ShootingDay(BaseModel):
    day: int
    location: str
    scenes: list[int]
    planned_eighths: int
    cast: list[str] = Field(default_factory=list)
    call_time: str = "07:00"
    notes: str = ""


class Schedule(BaseModel):
    days: list[ShootingDay]
    eighths_per_day: int
    total_days: int
    total_eighths: int


class BudgetLine(BaseModel):
    category: str
    item: str
    qty: float
    unit: str
    unit_cost: float
    total: float


class Budget(BaseModel):
    currency: str = "USD"
    lines: list[BudgetLine]
    subtotal: float
    contingency: float
    total: float
    assumptions: list[str] = Field(default_factory=list)


class ProducerNotes(BaseModel):
    """What a line producer would say about the plan before day 1."""
    risks: list[str] = Field(description="Concrete schedule or budget risks, most severe first")
    suggestions: list[str] = Field(description="Cheap changes that reduce those risks")
    summary: str


class DirectorNote(BaseModel):
    """The set director's end-of-day decision, grounded in Grafana evidence."""
    day: int
    status: Literal["on_track", "slipping", "over_budget", "blocked"]
    evidence: list[str] = Field(description="Facts read from Grafana, with numbers")
    decision: str = Field(description="What changes tomorrow, in one paragraph")
    replan: bool = Field(description="True if remaining days must be re-packed")
    move_scenes: list[int] = Field(default_factory=list, description="Scene numbers to push to later days")


class WrapReport(BaseModel):
    title: str
    days_planned: int
    days_shot: int
    scenes_completed: int
    scenes_total: int
    budget_planned: float
    budget_spent: float
    highlights: list[str]
    lessons: list[str]
    narrative: str
