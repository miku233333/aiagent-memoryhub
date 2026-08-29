from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

CheckStatus = Literal["pass", "warn", "fail", "skip"]


@dataclass(frozen=True)
class CheckResult:
    check_id: str
    title: str
    status: CheckStatus
    summary: str
    details: dict[str, Any] = field(default_factory=dict)
    remediation: str | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "id": self.check_id,
            "title": self.title,
            "status": self.status,
            "summary": self.summary,
            "details": self.details,
        }
        if self.remediation:
            result["remediation"] = self.remediation
        return result


@dataclass(frozen=True)
class DoctorReport:
    schema_version: str
    overall_status: CheckStatus
    platform: str
    project_root: str
    hub_url: str
    checks: list[CheckResult]

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "overall_status": self.overall_status,
            "platform": self.platform,
            "project_root": self.project_root,
            "hub_url": self.hub_url,
            "checks": [check.to_dict() for check in self.checks],
        }
