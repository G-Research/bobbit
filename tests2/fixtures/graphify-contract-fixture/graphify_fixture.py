#!/usr/bin/env python3
"""Test-only Graphify-shaped compatibility fixture.

It exposes graphify.watch._rebuild_code-like behavior through a tiny JSON CLI.
The linked-worktree guard is deliberate telemetry: an output under a checkout
increments it and fails, so tests cannot pass by asserting a dead counter.
"""
from __future__ import annotations

import hashlib
import inspect
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time
from typing import Any


def _read_payload() -> dict[str, Any]:
    return json.load(sys.stdin)


def _write_json(value: Any) -> None:
    json.dump(value, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")


def _load_telemetry(path: Path) -> dict[str, int]:
    if not path.exists():
        return {"compatibilityCalls": 0, "linkedWorktreeGuardCalls": 0}
    return json.loads(path.read_text(encoding="utf8"))


def _record(path: Path, field: str) -> None:
    telemetry = _load_telemetry(path)
    telemetry[field] = telemetry.get(field, 0) + 1
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(telemetry, sort_keys=True), encoding="utf8")


def _is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def linked_worktree_guard(root: Path, candidate_root: Path, telemetry_path: Path) -> None:
    """The observable linked-worktree guard entrypoint used by this fixture."""
    if _is_within(root, candidate_root):
        _record(telemetry_path, "linkedWorktreeGuardCalls")
        raise RuntimeError("Graphify fixture linked-worktree guard invoked for checkout-local output")


class _Watch:
    def _rebuild_code(
        self,
        root: str,
        changed_paths: list[str],
        candidate_root: str,
        scan_roots: list[str],
        no_cluster: bool,
        telemetry_path: str,
    ) -> dict[str, Any]:
        root_path = Path(root).resolve()
        # Preserve the caller's absolute spelling: the adapter validates lexical
        # containment, while resolve() would turn macOS /var into /private/var.
        output_root = Path(candidate_root).absolute()
        telemetry = Path(telemetry_path).absolute()
        linked_worktree_guard(root_path, output_root, telemetry)
        if not no_cluster:
            raise RuntimeError("Graphify fixture requires no_cluster=True for a delta")
        _record(telemetry, "compatibilityCalls")
        source_paths: list[str] = []
        for scan_root in sorted(set(scan_roots)):
            directory = root_path / scan_root
            if not directory.exists():
                continue
            for source in sorted(path for path in directory.rglob("*") if path.is_file()):
                source_paths.append(source.relative_to(root_path).as_posix())
        output_root.mkdir(parents=True, exist_ok=True)
        graph_path = output_root / "graph.json"
        graph_path.write_text(json.dumps({"changedPaths": sorted(changed_paths), "sourcePaths": source_paths}, sort_keys=True), encoding="utf8")
        return {
            "edges": max(len(source_paths) - 1, 0),
            "graphPath": str(graph_path),
            "nodes": len(source_paths),
            "sourcePaths": source_paths,
        }


watch = _Watch()


def probe() -> None:
    signature = list(inspect.signature(watch._rebuild_code).parameters)
    _write_json({"callable": "_rebuild_code", "modulePath": "graphify.watch", "signature": signature})


def invoke() -> None:
    payload = _read_payload()
    request = payload["request"]
    _write_json(watch._rebuild_code(
        root=request["cwd"],
        changed_paths=request["changedPaths"],
        candidate_root=request["candidateRoot"],
        scan_roots=request["scanRoots"],
        no_cluster=request["noCluster"],
        telemetry_path=payload["telemetryPath"],
    ))


def _digest_tree(root: Path) -> str:
    digest = hashlib.sha256()
    for source in sorted(path for path in root.rglob("*") if path.is_file()):
        digest.update(source.relative_to(root).as_posix().encode("utf8"))
        digest.update(source.read_bytes())
    return digest.hexdigest()


def benchmark(corpus_root: Path) -> None:
    """Measure fixture mechanics only; it never claims installed Graphify ran."""
    started = time.perf_counter_ns()
    with tempfile.TemporaryDirectory(prefix="graphify-contract-fixture-") as temp:
        state = Path(temp) / "host-state"
        base = state / "base"
        clone = state / "clone"
        candidate = state / "candidate"
        timings: list[dict[str, Any]] = []

        tick = time.perf_counter_ns()
        shutil.copytree(corpus_root, base)
        timings.append({"operation": "base", "elapsedMs": round((time.perf_counter_ns() - tick) / 1_000_000, 3)})

        tick = time.perf_counter_ns()
        shutil.copytree(base, clone)
        timings.append({"operation": "clone", "elapsedMs": round((time.perf_counter_ns() - tick) / 1_000_000, 3)})

        tick = time.perf_counter_ns()
        shutil.copytree(clone, candidate)
        target = candidate / "src" / "contract-delta.ts"
        target.write_text("export const contractDelta = true;\n", encoding="utf8")
        timings.append({"operation": "delta-no-cluster", "elapsedMs": round((time.perf_counter_ns() - tick) / 1_000_000, 3)})

        tick = time.perf_counter_ns()
        bytes_used = sum(source.stat().st_size for source in candidate.rglob("*") if source.is_file())
        timings.append({"operation": "size", "elapsedMs": round((time.perf_counter_ns() - tick) / 1_000_000, 3), "bytes": bytes_used})

        tick = time.perf_counter_ns()
        query_matches = sum(1 for source in candidate.rglob("*.ts") if "export" in source.read_text(encoding="utf8"))
        timings.append({"operation": "query", "elapsedMs": round((time.perf_counter_ns() - tick) / 1_000_000, 3), "matches": query_matches})
        nodes = sum(1 for source in candidate.rglob("*") if source.is_file())
        _write_json({
            "fixture": "contract-fixture",
            "fixtureRevision": json.loads((corpus_root / "fixture.json").read_text(encoding="utf8"))["revision"],
            "rootDigest": _digest_tree(corpus_root),
            "graph": {"nodes": nodes, "edges": max(nodes - 1, 0)},
            "elapsedMs": round((time.perf_counter_ns() - started) / 1_000_000, 3),
            "rows": timings,
        })


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: graphify_fixture.py probe|invoke|benchmark [corpus-root]")
    command = sys.argv[1]
    if command == "probe":
        probe()
    elif command == "invoke":
        invoke()
    elif command == "benchmark" and len(sys.argv) == 3:
        benchmark(Path(sys.argv[2]).resolve())
    else:
        raise SystemExit("usage: graphify_fixture.py probe|invoke|benchmark [corpus-root]")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
