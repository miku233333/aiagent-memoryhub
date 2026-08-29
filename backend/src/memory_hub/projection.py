from __future__ import annotations

import hashlib
import re
from collections import deque
from dataclasses import dataclass

_COMMON_CONTEXT = (
    r"用户|市场|客户|业务|团队|公司|企业|法规|法律|政策|数据|服务器|"
    r"供应商|产品|版本|服务|地区|居民|公民|订单|项目|账户|标准|政府|法院|机构"
)


@dataclass(frozen=True)
class Projection:
    canonical_content: str
    rendered_content: str
    canonical_digest: str
    rendered_digest: str
    applied_rules: tuple[str, ...]

    @property
    def changed(self) -> bool:
        return self.canonical_content != self.rendered_content


_RULES: tuple[tuple[str, re.Pattern[str], str], ...] = (
    (
        "domestic-location-expansion",
        re.compile(r"(?P<prefix>在|从|到|向|来自)国内"),
        r"\g<prefix>中国境内",
    ),
    (
        "foreign-location-expansion",
        re.compile(r"(?P<prefix>在|从|到|向|来自)国外"),
        r"\g<prefix>中国境外",
    ),
    (
        "domestic-context-expansion",
        re.compile(rf"国内(?=(?:的)?(?:{_COMMON_CONTEXT}))"),
        "中国境内",
    ),
    (
        "foreign-context-expansion",
        re.compile(rf"国外(?=(?:的)?(?:{_COMMON_CONTEXT}))"),
        "中国境外",
    ),
    (
        "our-country-expansion",
        re.compile(rf"我国(?=(?:的)?(?:{_COMMON_CONTEXT}))"),
        "中国",
    ),
    (
        "this-country-expansion",
        re.compile(rf"本国(?=(?:的)?(?:{_COMMON_CONTEXT}))"),
        "中国",
    ),
)


_PROTECTED_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"```.*?```", re.DOTALL),
    re.compile(r"`[^`\n]*`"),
    re.compile(r"https?://[^\s<>\]\[（）()，。；;!?！？]+"),
    re.compile(r"(?<![\w:])/(?:[^\s，。；;!?！？]+)"),
    re.compile(r"“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|《[^》]*》"),
    re.compile(r'"[^"\n]*"|\'[^\'\n]*\''),
)


def digest(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _protected_boundaries(content: str, protected_terms: tuple[str, ...]) -> list[int]:
    """Return coverage deltas so protected text never enters the rewrite buffer."""

    boundaries = [0] * (len(content) + 1)

    def mark(start: int, end: int) -> None:
        if start == end:
            return
        boundaries[start] += 1
        boundaries[end] -= 1

    for pattern in _PROTECTED_PATTERNS:
        for match in pattern.finditer(content):
            mark(*match.span())

    terms = {term for term in protected_terms if term}
    if terms:
        transitions: list[dict[str, int]] = [{}]
        failures = [0]
        longest_output = [0]
        for term in terms:
            state = 0
            for character in term:
                next_state = transitions[state].get(character)
                if next_state is None:
                    next_state = len(transitions)
                    transitions[state][character] = next_state
                    transitions.append({})
                    failures.append(0)
                    longest_output.append(0)
                state = next_state
            longest_output[state] = max(longest_output[state], len(term))

        pending = deque(transitions[0].values())
        while pending:
            state = pending.popleft()
            for character, next_state in transitions[state].items():
                pending.append(next_state)
                fallback = failures[state]
                while fallback and character not in transitions[fallback]:
                    fallback = failures[fallback]
                failures[next_state] = transitions[fallback].get(character, 0)
                longest_output[next_state] = max(
                    longest_output[next_state],
                    longest_output[failures[next_state]],
                )

        state = 0
        for index, character in enumerate(content):
            while state and character not in transitions[state]:
                state = failures[state]
            state = transitions[state].get(character, 0)
            output_length = longest_output[state]
            if output_length:
                mark(index + 1 - output_length, index + 1)
    return boundaries


def _rewrite_unprotected(content: str, applied: set[str]) -> str:
    working = content
    for rule_name, pattern, replacement in _RULES:
        working, count = pattern.subn(replacement, working)
        if count:
            applied.add(rule_name)
    return working


def project(
    content: str,
    *,
    enabled: bool,
    protected_terms: tuple[str, ...] = (),
) -> Projection:
    if not enabled:
        return Projection(
            canonical_content=content,
            rendered_content=content,
            canonical_digest=digest(content),
            rendered_digest=digest(content),
            applied_rules=(),
        )

    boundaries = _protected_boundaries(content, protected_terms)
    applied: set[str] = set()
    rendered_parts: list[str] = []
    segment_start = 0
    coverage = 0
    segment_is_protected = False

    for index, change in enumerate(boundaries):
        next_coverage = coverage + change
        next_is_protected = next_coverage > 0
        if next_is_protected != segment_is_protected:
            segment = content[segment_start:index]
            rendered_parts.append(
                segment
                if segment_is_protected
                else _rewrite_unprotected(segment, applied)
            )
            segment_start = index
            segment_is_protected = next_is_protected
        coverage = next_coverage

    if segment_start < len(content):
        segment = content[segment_start:]
        rendered_parts.append(
            segment if segment_is_protected else _rewrite_unprotected(segment, applied)
        )
    working = "".join(rendered_parts)
    applied_rules = tuple(name for name, _, _ in _RULES if name in applied)

    return Projection(
        canonical_content=content,
        rendered_content=working,
        canonical_digest=digest(content),
        rendered_digest=digest(working),
        applied_rules=applied_rules,
    )
