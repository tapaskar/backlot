"""Push production telemetry to Grafana over OTLP/HTTP.

Metrics (all labelled project=<slug>):
  backlot_scenes_total, backlot_scenes_completed, backlot_eighths_planned_today,
  backlot_eighths_completed_today, backlot_takes_total, backlot_setups_total,
  backlot_delay_minutes{cause}, backlot_budget_planned_usd, backlot_budget_spent_usd,
  backlot_day
Logs: one line per production event, attributes project, day, kind, scene.

With no OTLP endpoint configured, everything is kept in memory so the app and
tests still run; the director then reads the in-memory store instead of Grafana.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

from . import config

log = logging.getLogger("backlot.telemetry")


@dataclass
class Event:
    ts: float
    project: str
    day: int
    kind: str
    message: str
    scene: int | None = None
    attrs: dict = field(default_factory=dict)


class Telemetry:
    def __init__(self, service_name: str = "backlot"):
        self.events: list[Event] = []
        self.gauges: dict[tuple[str, tuple[tuple[str, str], ...]], float] = {}
        self.enabled = bool(config.OTLP_METRICS_ENDPOINT or config.OTLP_LOGS_ENDPOINT)
        self._meter = self._logger = None
        self._instruments: dict[str, object] = {}
        if self.enabled:
            self._setup_otel(service_name)

    # ----------------------------------------------------------- OTel wiring
    def _setup_otel(self, service_name: str):
        from opentelemetry import metrics
        from opentelemetry._logs import set_logger_provider
        from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
        from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
        from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import Resource

        headers = {"Authorization": config.OTLP_AUTH_HEADER} if config.OTLP_AUTH_HEADER else {}
        res = Resource.create({"service.name": service_name})
        if config.OTLP_METRICS_ENDPOINT:
            reader = PeriodicExportingMetricReader(
                OTLPMetricExporter(endpoint=config.OTLP_METRICS_ENDPOINT, headers=headers),
                export_interval_millis=5000)
            metrics.set_meter_provider(MeterProvider(resource=res, metric_readers=[reader]))
            self._meter = metrics.get_meter("backlot")
        if config.OTLP_LOGS_ENDPOINT:
            lp = LoggerProvider(resource=res)
            lp.add_log_record_processor(BatchLogRecordProcessor(
                OTLPLogExporter(endpoint=config.OTLP_LOGS_ENDPOINT, headers=headers)))
            set_logger_provider(lp)
            self._logger = logging.getLogger("backlot.production")
            self._logger.setLevel(logging.INFO)
            self._logger.addHandler(LoggingHandler(level=logging.INFO, logger_provider=lp))
            self._logger.propagate = False

    def _gauge(self, name: str):
        if self._meter is None:
            return None
        if name not in self._instruments:
            key = name
            store = self.gauges

            def cb(_opts, key=key, store=store):
                from opentelemetry.metrics import Observation
                return [Observation(v, dict(lbls)) for (n, lbls), v in store.items() if n == key]
            self._instruments[name] = self._meter.create_observable_gauge(name, callbacks=[cb])
        return self._instruments[name]

    # ----------------------------------------------------------------- API
    def set(self, name: str, value: float, **labels: str):
        key = (name, tuple(sorted((k, str(v)) for k, v in labels.items())))
        self.gauges[key] = float(value)
        self._gauge(name)

    def inc(self, name: str, delta: float = 1, **labels: str):
        key = (name, tuple(sorted((k, str(v)) for k, v in labels.items())))
        self.gauges[key] = self.gauges.get(key, 0.0) + delta
        self._gauge(name)

    def get(self, name: str, **labels: str) -> float:
        key = (name, tuple(sorted((k, str(v)) for k, v in labels.items())))
        return self.gauges.get(key, 0.0)

    def event(self, project: str, day: int, kind: str, message: str, scene: int | None = None, **attrs):
        e = Event(time.time(), project, day, kind, message, scene, attrs)
        self.events.append(e)
        if self._logger is not None:
            self._logger.info(message, extra={"project": project, "day": day, "kind": kind,
                                              "scene": scene or 0, **attrs})
        log.info("[%s d%d %s] %s", project, day, kind, message)
        return e

    def flush(self):
        try:
            from opentelemetry import metrics
            mp = metrics.get_meter_provider()
            if hasattr(mp, "force_flush"):
                mp.force_flush()
            from opentelemetry._logs import get_logger_provider
            lp = get_logger_provider()
            if hasattr(lp, "force_flush"):
                lp.force_flush()
        except Exception as e:  # pragma: no cover - never let telemetry break the shoot
            log.warning("flush failed: %s", e)

    def summary(self, project: str) -> dict:
        """What the director reads when Grafana is not configured."""
        g = {n + ("" if not l else "{" + ",".join(f"{k}={v}" for k, v in l) + "}"): v
             for (n, l), v in self.gauges.items() if ("project", project) in l}
        ev = [f"day {e.day} [{e.kind}] {e.message}" for e in self.events if e.project == project][-40:]
        return {"metrics": g, "recent_events": ev}


telemetry = Telemetry()
