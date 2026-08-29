from __future__ import annotations

from .models import DoctorReport
from .setup import SetupPlan, SetupReceipt

_MARKERS = {"pass": "OK", "warn": "WARN", "fail": "FAIL", "skip": "SKIP"}


def render_doctor_report(report: DoctorReport) -> str:
    lines = [
        f"OmniMemory 环境检查：{report.overall_status.upper()}",
        f"项目：{report.project_root}",
        f"Memory Hub：{report.hub_url}",
        "",
    ]
    for check in report.checks:
        lines.append(f"[{_MARKERS[check.status]}] {check.title} — {check.summary}")
        if check.remediation:
            lines.append(f"      建议：{check.remediation}")
    lines.extend(
        [
            "",
            "隐私：报告不包含环境变量值、API key、认证头或健康端点原始响应。",
        ]
    )
    return "\n".join(lines) + "\n"


def render_setup_plan(plan: SetupPlan) -> str:
    heading = (
        "OmniMemory 搭建计划（DRY RUN，未写入）"
        if plan.dry_run
        else "OmniMemory 搭建计划"
    )
    lines = [heading, f"状态：{plan.status}", f"项目：{plan.project_root}", ""]
    for action in plan.actions:
        lines.append(f"- {action.summary}")
        lines.append(f"  目标：{action.target}")
        for change in action.changes:
            lines.append(f"  · {change}")
    for warning in plan.warnings:
        lines.append(f"[WARN] {warning}")
    for error in plan.errors:
        lines.append(f"[FAIL] {error}")
    if plan.status == "ready":
        lines.extend(["", "没有写入任何文件。确认后使用同一命令加 --apply。"])
    elif plan.status == "noop":
        lines.extend(["", "当前配置已符合计划，无需写入。"])
    return "\n".join(lines) + "\n"


def render_setup_receipt(receipt: SetupReceipt) -> str:
    lines = [f"搭建结果：{receipt.status}"]
    for path in receipt.changed_files:
        lines.append(f"- 已更新：{path}")
    for path in receipt.backups:
        lines.append(f"- 备份：{path}")
    return "\n".join(lines) + "\n"
