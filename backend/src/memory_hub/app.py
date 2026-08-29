from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from urllib.parse import unquote

from fastapi import FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.exception_handlers import http_exception_handler
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.staticfiles import StaticFiles

from .http_security import (
    RequestBodyLimitMiddleware,
    TRUSTED_LOOPBACK_HOSTS,
    V1RequestSecurityMiddleware,
)

from .models import (
    CheckpointRequest,
    CheckpointResponse,
    ContextPackItem,
    ContextPackRequest,
    ContextPackResponse,
    ForgetRequest,
    ItemResponse,
    ItemsResponse,
    MemoryProposal,
    MemorySearchRequest,
    MemoryStatus,
    ProjectionRequest,
    ProjectionResponse,
    ProjectionTarget,
    Scope,
    ScopeRequest,
    SettingResponse,
    SettingUpdate,
    TombstoneResponse,
)
from .projection import project
from .security import detect_secrets
from .storage import ForgottenMemoryError, IdempotencyConflictError, Storage

SCHEMA_VERSION = "v1"
_RESERVED_WEB_PREFIXES = ("v1", "health", "mcp")


class _ReadTokenFromEnvironment:
    pass


_READ_TOKEN_FROM_ENVIRONMENT = _ReadTokenFromEnvironment()


def _is_reserved_web_path(path: str) -> bool:
    normalized = path.lstrip("/")
    return any(
        normalized == prefix or normalized.startswith(f"{prefix}/")
        for prefix in _RESERVED_WEB_PREFIXES
    )


def _resolve_web_dir(configured: str | None) -> Path | None:
    if configured is None:
        return None
    if not configured.strip():
        raise RuntimeError("MEMORY_HUB_WEB_DIR must be a non-empty directory")
    try:
        web_dir = Path(configured).expanduser().resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as error:
        raise RuntimeError(
            "MEMORY_HUB_WEB_DIR must resolve to an existing directory"
        ) from error
    if not web_dir.is_dir():
        raise RuntimeError("MEMORY_HUB_WEB_DIR must resolve to a directory")
    try:
        index = (web_dir / "index.html").resolve(strict=True)
        index.relative_to(web_dir)
    except (OSError, RuntimeError, ValueError) as error:
        raise RuntimeError(
            "MEMORY_HUB_WEB_DIR must contain a safe index.html"
        ) from error
    if not index.is_file():
        raise RuntimeError("MEMORY_HUB_WEB_DIR index.html must be a regular file")
    return web_dir


def _is_unsafe_web_path(path: str) -> bool:
    decoded = path
    try:
        for _ in range(2):
            decoded = unquote(decoded, errors="strict")
    except UnicodeDecodeError:
        return True
    normalized = decoded.replace("\\", "/")
    return any(segment in {".", ".."} for segment in normalized.split("/"))


def _secure_web_response(response: Response) -> Response:
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    return response


def _resolve_auth_token(configured: str | None) -> str | None:
    if configured is None:
        return None
    if (
        not configured
        or len(configured) > 4_096
        or configured != configured.strip()
        or any(character.isspace() for character in configured)
        or any(
            ord(character) < 0x21 or ord(character) > 0x7E for character in configured
        )
    ):
        raise RuntimeError(
            "MEMORY_HUB_TOKEN must be a non-empty visible ASCII bearer token"
        )
    return configured


def create_app(
    database_path: str | Path | None = None,
    *,
    token: str | None | _ReadTokenFromEnvironment = _READ_TOKEN_FROM_ENVIRONMENT,
) -> FastAPI:
    """Create an isolated Memory Hub application instance."""

    resolved_database_path = Path(
        database_path
        or os.environ.get("MEMORY_HUB_DATABASE", "./data/memory-hub.sqlite3")
    )
    web_dir = _resolve_web_dir(os.environ.get("MEMORY_HUB_WEB_DIR"))
    configured_token = _resolve_auth_token(
        os.environ.get("MEMORY_HUB_TOKEN")
        if token is _READ_TOKEN_FROM_ENVIRONMENT
        else token
    )

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        application.state.storage = Storage(resolved_database_path)
        yield

    app = FastAPI(title="AI Agent Memory Hub", version="0.1.0", lifespan=lifespan)
    app.state.database_path = resolved_database_path
    app.state.auth_enabled = configured_token is not None
    app.add_middleware(RequestBodyLimitMiddleware)
    app.add_middleware(V1RequestSecurityMiddleware, token=configured_token)
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=list(TRUSTED_LOOPBACK_HOSTS),
        www_redirect=False,
    )

    @app.get("/health", tags=["system"])
    def health() -> dict[str, str]:
        return {
            "status": "ok",
            "service": "memory-hub",
            "schema_version": SCHEMA_VERSION,
        }

    @app.api_route("/mcp", methods=["GET", "POST", "DELETE"], tags=["mcp"])
    def mcp_transport_placeholder() -> None:
        raise HTTPException(
            status_code=501,
            detail={
                "code": "mcp_transport_not_installed",
                "message": "Use the v1 REST API until Streamable HTTP MCP is added",
            },
        )

    @app.post(
        "/v1/memory/proposals",
        response_model=ItemResponse,
        status_code=status.HTTP_201_CREATED,
        tags=["memory"],
    )
    def propose_memory(
        proposal: MemoryProposal,
        idempotency_key: str | None = Header(
            default=None, alias="Idempotency-Key", max_length=200
        ),
    ) -> ItemResponse:
        detectors = detect_secrets(
            proposal.content
            + "\n"
            + json.dumps(proposal.metadata, ensure_ascii=False, sort_keys=True)
        )
        if detectors:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "secret_detected",
                    "message": "Content blocked before storage or projection",
                    "detectors": list(detectors),
                },
            )
        if idempotency_key is not None:
            idempotency_key = idempotency_key.strip()
            if not idempotency_key:
                raise HTTPException(
                    status_code=400, detail="Idempotency key must not be blank"
                )
        try:
            item = app.state.storage.propose(proposal, idempotency_key)
        except IdempotencyConflictError as error:
            raise HTTPException(
                status_code=409,
                detail="Idempotency key reused with different request",
            ) from error
        return ItemResponse(item=item)

    @app.get(
        "/v1/memory/proposals",
        response_model=ItemsResponse,
        tags=["memory"],
    )
    def list_memory_proposals(
        user_id: str = Query(min_length=1, max_length=200),
        project_id: str | None = Query(default=None, min_length=1, max_length=200),
        status_filter: Annotated[MemoryStatus, Query(alias="status")] = (
            MemoryStatus.PENDING
        ),
        limit: int = Query(default=100, ge=1, le=100),
    ) -> ItemsResponse:
        scope = Scope(user_id=user_id, project_id=project_id)
        return ItemsResponse(
            items=app.state.storage.list_by_status(scope, status_filter, limit=limit)
        )

    @app.post(
        "/v1/memory/proposals/{memory_id}/approve",
        response_model=ItemResponse,
        tags=["memory"],
    )
    def approve_memory(memory_id: str, request: ScopeRequest) -> ItemResponse:
        try:
            item = app.state.storage.approve(memory_id, request.scope)
        except ForgottenMemoryError as error:
            raise HTTPException(
                status_code=409, detail="Forgotten memory cannot be approved"
            ) from error
        if item is None:
            raise HTTPException(status_code=404, detail="Memory proposal not found")
        return ItemResponse(item=item)

    @app.get("/v1/memories", response_model=ItemsResponse, tags=["memory"])
    def list_memories(
        user_id: str = Query(min_length=1, max_length=200),
        project_id: str | None = Query(default=None, min_length=1, max_length=200),
        include_global: bool = True,
    ) -> ItemsResponse:
        scope = Scope(user_id=user_id, project_id=project_id)
        return ItemsResponse(
            items=app.state.storage.list_approved(scope, include_global=include_global)
        )

    @app.post("/v1/memories/search", response_model=ItemsResponse, tags=["memory"])
    def search_memories(request: MemorySearchRequest) -> ItemsResponse:
        return ItemsResponse(
            items=app.state.storage.search_approved(
                request.scope,
                request.query,
                limit=request.limit,
                include_global=request.include_global,
            )
        )

    @app.post(
        "/v1/memories/{memory_id}/forget",
        response_model=TombstoneResponse,
        tags=["memory"],
    )
    def forget_memory(memory_id: str, request: ForgetRequest) -> TombstoneResponse:
        tombstone = app.state.storage.forget(memory_id, request.scope, request.reason)
        if tombstone is None:
            raise HTTPException(status_code=404, detail="Memory not found")
        return TombstoneResponse(tombstone=tombstone)

    @app.get(
        "/v1/settings/{user_id}/{target}",
        response_model=SettingResponse,
        tags=["settings"],
    )
    def get_setting(user_id: str, target: ProjectionTarget) -> SettingResponse:
        validated_user = Scope(user_id=user_id).user_id
        return SettingResponse(
            setting=app.state.storage.get_setting(validated_user, target)
        )

    @app.put(
        "/v1/settings/{user_id}/{target}",
        response_model=SettingResponse,
        tags=["settings"],
    )
    def put_setting(
        user_id: str, target: ProjectionTarget, request: SettingUpdate
    ) -> SettingResponse:
        validated_user = Scope(user_id=user_id).user_id
        return SettingResponse(
            setting=app.state.storage.put_setting(
                validated_user, target, request.cross_cultural_polish
            )
        )

    def render_projection(request: ProjectionRequest) -> ProjectionResponse:
        detectors = detect_secrets(request.content)
        if detectors:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "secret_detected",
                    "message": "Content blocked before storage or projection",
                    "detectors": list(detectors),
                },
            )
        validated_user = Scope(user_id=request.user_id).user_id
        setting = app.state.storage.get_setting(validated_user, request.target)
        result = project(
            request.content,
            enabled=setting.cross_cultural_polish,
            protected_terms=tuple(request.protected_terms),
        )
        return ProjectionResponse(
            target=request.target,
            enabled=setting.cross_cultural_polish,
            changed=result.changed,
            canonical_content=result.canonical_content,
            rendered_content=result.rendered_content,
            canonical_digest=result.canonical_digest,
            rendered_digest=result.rendered_digest,
            applied_rules=list(result.applied_rules),
        )

    app.post(
        "/v1/projections/preview",
        response_model=ProjectionResponse,
        tags=["projection"],
    )(render_projection)

    @app.post(
        "/v1/context-pack",
        response_model=ContextPackResponse,
        tags=["context"],
    )
    def context_pack(request: ContextPackRequest) -> ContextPackResponse:
        if request.query:
            memories = app.state.storage.search_approved(
                request.scope,
                request.query,
                limit=request.limit,
                include_global=request.include_global,
            )
        else:
            memories = app.state.storage.list_approved(
                request.scope, include_global=request.include_global
            )[: request.limit]

        setting = (
            app.state.storage.get_setting(request.scope.user_id, request.target)
            if request.target is not None
            else None
        )
        enabled = bool(setting and setting.cross_cultural_polish)
        context_items: list[ContextPackItem] = []
        for memory in memories:
            detectors = detect_secrets(memory.content)
            if detectors:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "secret_detected",
                        "message": "Context pack blocked before egress",
                        "detectors": list(detectors),
                    },
                )
            result = project(memory.content, enabled=enabled)
            context_items.append(
                ContextPackItem(
                    id=memory.id,
                    scope=memory.scope,
                    canonical_content=result.canonical_content,
                    rendered_content=result.rendered_content,
                    canonical_digest=result.canonical_digest,
                    rendered_digest=result.rendered_digest,
                    changed=result.changed,
                    source_platform=memory.source_platform,
                    created_at=memory.created_at,
                )
            )
        return ContextPackResponse(
            scope=request.scope,
            target=request.target,
            items=context_items,
            rendered_content="\n\n".join(
                item.rendered_content for item in context_items
            ),
            setting=setting,
        )

    @app.post(
        "/v1/checkpoints",
        response_model=CheckpointResponse,
        status_code=status.HTTP_201_CREATED,
        tags=["checkpoint"],
    )
    def create_checkpoint(
        request: CheckpointRequest,
        idempotency_key: str | None = Header(
            default=None, alias="Idempotency-Key", max_length=200
        ),
    ) -> CheckpointResponse:
        detectors = detect_secrets(
            request.summary
            + "\n"
            + json.dumps(request.metadata, ensure_ascii=False, sort_keys=True)
        )
        if detectors:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "secret_detected",
                    "message": "Content blocked before storage or projection",
                    "detectors": list(detectors),
                },
            )
        if idempotency_key is not None:
            idempotency_key = idempotency_key.strip()
            if not idempotency_key:
                raise HTTPException(
                    status_code=400, detail="Idempotency key must not be blank"
                )
        try:
            checkpoint = app.state.storage.create_checkpoint(request, idempotency_key)
        except IdempotencyConflictError as error:
            raise HTTPException(
                status_code=409,
                detail="Idempotency key reused with different request",
            ) from error
        return CheckpointResponse(checkpoint=checkpoint)

    app.post(
        "/v1/projections/render",
        response_model=ProjectionResponse,
        tags=["projection"],
    )(render_projection)

    if web_dir is not None:
        static_files = StaticFiles(
            directory=web_dir,
            check_dir=True,
            follow_symlink=False,
        )

        @app.exception_handler(404)
        async def web_ui_not_found(
            request: Request, error: StarletteHTTPException
        ) -> Response:
            raw_path = request.scope.get("raw_path", b"")
            raw_path_text = (
                raw_path.decode("ascii", errors="ignore")
                if isinstance(raw_path, bytes)
                else ""
            )
            if (
                request.method not in {"GET", "HEAD"}
                or _is_reserved_web_path(request.url.path)
                or _is_unsafe_web_path(request.url.path)
                or _is_unsafe_web_path(raw_path_text)
            ):
                return await http_exception_handler(request, error)
            web_path = request.url.path.lstrip("/")
            try:
                response = await static_files.get_response(web_path, request.scope)
            except StarletteHTTPException as static_error:
                if static_error.status_code != 404:
                    raise
                response = await static_files.get_response("index.html", request.scope)
            return _secure_web_response(response)

    return app


app = create_app()


def _require_runtime_auth(application: FastAPI) -> None:
    if not bool(application.state.auth_enabled):
        raise RuntimeError(
            "MEMORY_HUB_TOKEN is required when starting the Memory Hub service"
        )


def run() -> None:
    import uvicorn

    _require_runtime_auth(app)
    uvicorn.run(
        app,
        host=os.environ.get("MEMORY_HUB_HOST", "127.0.0.1"),
        port=int(os.environ.get("MEMORY_HUB_PORT", "8787")),
    )
