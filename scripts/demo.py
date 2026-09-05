#!/usr/bin/env python3
"""Drive a whole production through the API - the exact sequence in the demo video.

    python scripts/demo.py --base http://localhost:8080 --chaos 0.5
"""
import argparse
import json
import sys
from pathlib import Path

import httpx

ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://localhost:8080")
ap.add_argument("--script", default=str(Path(__file__).with_name("demo_script.fountain")))
ap.add_argument("--pages-per-day", type=float, default=1.5)
ap.add_argument("--chaos", type=float, default=0.5)
a = ap.parse_args()

c = httpx.Client(base_url=a.base, timeout=600)
h = c.get("/api/health").json(); print("health:", json.dumps(h))
p = c.post("/api/projects", json={"script": Path(a.script).read_text()}).json()
slug = p["slug"]; print(f"\n{p['title']}: {len(p['breakdown']['scenes'])} scenes parsed")
p = c.post(f"/api/projects/{slug}/greenlight", params={"eighths_per_day": int(a.pages_per_day * 8)}).json()
print(f"greenlit: {p['schedule']['total_days']} days, ${p['budget']['total']:,.0f}; dashboard: {p['dashboard'].get('url', '-')}")
for d in p["schedule"]["days"]:
    print(f"  day {d['day']}: {d['location']} scenes {d['scenes']} ({d['planned_eighths']}/8) {d['notes']}")
print("producer:", p["producer_notes"]["summary"])
for i in range(40):
    p = c.post(f"/api/projects/{slug}/shoot", json={"chaos": a.chaos, "seed": i}).json()
    if "error" in p or "detail" in p:
        print(p); sys.exit(1)
    d = p["days"][-1]; n = d["director"]
    print(f"\nday {d['day']}: {n['status']} - {n['decision']}")
    for e in n["evidence"]:
        print("   ·", e)
    if p["status"] != "shooting":
        break
p = c.post(f"/api/projects/{slug}/wrap").json()
w = p["wrap"]; print(f"\nWRAP: {w['scenes_completed']}/{w['scenes_total']} scenes, {w['days_shot']}/{w['days_planned']} days, "
                    f"${w['budget_spent']:,.0f} of ${w['budget_planned']:,.0f}\n{w['narrative']}")
