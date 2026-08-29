from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Sequence, TextIO

from .doctor import DoctorOptions, EnvironmentDoctor
from .rendering import render_doctor_report, render_setup_plan, render_setup_receipt
from .setup import SetupOptions, SetupPlanner

VERSION = "0.1.0"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="omnimemory-env",
        description="Inspect and safely prepare a local OmniMemory + Claude Code environment.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    commands = parser.add_subparsers(dest="command", required=True)

    check = commands.add_parser("check", help="Run read-only environment checks.")
    check.add_argument("--project-root", type=Path, default=Path.cwd())
    check.add_argument("--hub-url", default="http://127.0.0.1:8787")
    check.add_argument("--home", type=Path, default=None, help=argparse.SUPPRESS)
    check.add_argument(
        "--allow-remote-health",
        action="store_true",
        help="Allow a health request to a non-loopback host.",
    )
    check.add_argument(
        "--probe-mcp",
        action="store_true",
        help="Also run `claude mcp list`; this can start or connect to configured MCP servers.",
    )
    check.add_argument(
        "--probe-network",
        action="store_true",
        help="Opt in to DNS and direct TLS checks for claude.ai and api.anthropic.com only; no HTTP is sent.",
    )
    check.add_argument(
        "--json",
        action="store_true",
        help="Emit the versioned machine-readable JSON report.",
    )

    setup = commands.add_parser(
        "setup",
        help="Plan local Claude Code hook/MCP configuration; dry-run by default.",
    )
    setup.add_argument("--project-root", type=Path, default=Path.cwd())
    setup.add_argument("--hook-entry", type=Path, default=None)
    setup.add_argument("--hub-url", default="http://127.0.0.1:8787")
    setup.add_argument(
        "--user-id",
        default="local-user",
        help="Pseudonymous local Memory Hub user slug; never use a secret.",
    )
    setup.add_argument(
        "--mcp-url",
        default=None,
        help="Optionally add a credential-free project MCP HTTP endpoint.",
    )
    setup.add_argument(
        "--allow-remote-mcp",
        action="store_true",
        help="Allow a non-loopback MCP URL; credentials remain forbidden.",
    )
    setup.add_argument(
        "--apply",
        action="store_true",
        help="Apply the displayed local configuration plan. Existing files are backed up first.",
    )
    setup.add_argument(
        "--json", action="store_true", help="Emit versioned machine-readable JSON."
    )
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    out = stdout or sys.stdout
    err = stderr or sys.stderr
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.command == "check":
        try:
            report = EnvironmentDoctor().run(
                DoctorOptions(
                    project_root=args.project_root,
                    hub_url=args.hub_url,
                    home=args.home,
                    allow_remote_health=args.allow_remote_health,
                    probe_mcp=args.probe_mcp,
                    probe_network=args.probe_network,
                )
            )
        except ValueError as exc:
            payload = {
                "schema_version": "omnimemory.env-doctor/error/v1",
                "status": "blocked",
                "error": str(exc),
            }
            if args.json:
                out.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
            else:
                err.write(f"环境检查已阻止：{exc}\n")
            return 2
        if args.json:
            out.write(json.dumps(report.to_dict(), ensure_ascii=False, indent=2) + "\n")
        else:
            out.write(render_doctor_report(report))
        return 1 if report.overall_status == "fail" else 0

    planner = SetupPlanner()
    plan = planner.build(
        SetupOptions(
            project_root=args.project_root,
            hook_entry=args.hook_entry,
            hub_url=args.hub_url,
            user_id=args.user_id,
            mcp_url=args.mcp_url,
            allow_remote_mcp=args.allow_remote_mcp,
        )
    )
    if plan.status == "blocked":
        if args.json:
            out.write(json.dumps(plan.to_dict(), ensure_ascii=False, indent=2) + "\n")
        else:
            out.write(render_setup_plan(plan))
        return 2

    if not args.apply:
        if args.json:
            out.write(json.dumps(plan.to_dict(), ensure_ascii=False, indent=2) + "\n")
        else:
            out.write(render_setup_plan(plan))
        return 0

    try:
        receipt = planner.apply(plan)
    except (OSError, RuntimeError, ValueError) as exc:
        payload = {
            "schema_version": "omnimemory.env-doctor/error/v1",
            "status": "blocked",
            "error": str(exc),
        }
        if args.json:
            out.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        else:
            err.write(f"搭建已阻止：{exc}\n")
        return 2
    if args.json:
        out.write(
            json.dumps(
                {"plan": plan.to_dict(), "receipt": receipt.to_dict()},
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        )
    else:
        out.write(render_setup_receipt(receipt))
    return 0
