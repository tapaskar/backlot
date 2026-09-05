"""End-to-end through the API in offline mode: break down -> greenlight -> shoot -> wrap."""
import os

os.environ["BACKLOT_OFFLINE"] = "1"
os.environ["BACKLOT_DATA_DIR"] = os.path.join(os.path.dirname(__file__), "_data")

from fastapi.testclient import TestClient  # noqa: E402

from backlot.web.app import app  # noqa: E402

client = TestClient(app)


def test_full_production_offline():
    demo = client.get("/api/demo-script").json()
    r = client.post("/api/projects", json={"script": demo["script"]}); assert r.status_code == 201, r.text
    slug = r.json()["slug"]; assert r.json()["title"] == "THE LAST FERRY"
    r = client.post(f"/api/projects/{slug}/greenlight?eighths_per_day=16"); assert r.status_code == 200, r.text
    p = r.json(); assert p["status"] == "greenlit" and p["schedule"]["total_days"] >= 2 and p["budget"]["total"] > 0
    assert p["producer_notes"]["summary"]
    days = p["schedule"]["total_days"]; statuses = []
    for i in range(days):
        r = client.post(f"/api/projects/{slug}/shoot", json={"chaos": 0.8, "seed": i}); assert r.status_code == 200, r.text
        p = r.json(); statuses.append(p["days"][-1]["director"]["status"])
        if p["status"] == "shot":
            break
    assert p["days"] and all(s in ("on_track", "slipping", "over_budget", "blocked") for s in statuses)
    # a re-packed schedule never loses or duplicates a scene
    scenes = sorted(n for d in p["schedule"]["days"] for n in d["scenes"])
    assert scenes == list(range(1, len(p["breakdown"]["scenes"]) + 1))
    r = client.post(f"/api/projects/{slug}/wrap"); assert r.status_code == 200, r.text
    w = r.json()["wrap"]; assert w["scenes_total"] == 8 and w["days_shot"] == len(p["days"])
    assert client.get(f"/api/projects/{slug}").json()["status"] == "wrapped"
    assert client.get("/api/health").json()["offline"] is True


def test_bad_script_rejected():
    r = client.post("/api/projects", json={"script": "just some prose without headings"})
    assert r.status_code == 400


def test_chat_is_refused_offline_with_a_clear_reason():
    r = client.post("/api/chat", json={"message": "write me a short"})
    assert r.status_code == 503 and "Gemini" in r.json()["detail"]
