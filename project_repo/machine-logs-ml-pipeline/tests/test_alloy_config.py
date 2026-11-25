from __future__ import annotations

import json
import re
from pathlib import Path

DEPLOY_DIR = Path(__file__).resolve().parent.parent / "deploy"


def test_alloy_config_syntax_and_low_cardinality() -> None:
    alloy_path = DEPLOY_DIR / "alloy" / "config.alloy"
    content = alloy_path.read_text(encoding="utf-8")

    assert "stage.forward_to" not in content
    assert "forward_to = [loki.write.default.receiver]" in content

    labels_match = re.search(r"stage\.labels\s*\{.*?values\s*=\s*\{(.*?)\}", content, re.DOTALL)
    assert labels_match is not None, "Missing stage.labels block"
    labels_block = labels_match.group(1)

    forbidden_labels = {"event_id", "run_id", "machine_id", "timestamp", "temp_c", "vibration_mm_s", "cycle_ms"}
    for forbidden in forbidden_labels:
        assert re.search(rf"\b{forbidden}\b", labels_block) is None, f"High-cardinality label found: {forbidden}"

    for expected in ("level", "line_id", "machine_type"):
        assert re.search(rf"\b{expected}\b", labels_block) is not None


def test_grafana_provisioning_uid_consistency() -> None:
    loki_ds = (DEPLOY_DIR / "grafana" / "provisioning" / "datasources" / "loki.yml").read_text(encoding="utf-8")
    assert "uid: loki" in loki_ds

    pg_ds = (DEPLOY_DIR / "grafana" / "provisioning" / "datasources" / "postgres.yml").read_text(encoding="utf-8")
    assert "uid: postgres-ml" in pg_ds

    loki_dash = json.loads((DEPLOY_DIR / "grafana" / "dashboards" / "machine_logs_overview.json").read_text(encoding="utf-8"))
    assert len(loki_dash["panels"]) >= 3
    for panel in loki_dash["panels"]:
        assert panel["datasource"]["uid"] == "loki"

    ml_dash = json.loads((DEPLOY_DIR / "grafana" / "dashboards" / "ml_features_overview.json").read_text(encoding="utf-8"))
    assert len(ml_dash["panels"]) >= 2
    for panel in ml_dash["panels"]:
        assert panel["datasource"]["uid"] == "postgres-ml"
