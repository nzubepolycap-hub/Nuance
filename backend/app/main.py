"""FastAPI entrypoint.

Scope note: settings land as part of the auth router (`PATCH /auth/
settings`, see routers/auth.py) rather than their own module.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import models  # noqa: F401 — import registers tables on Base.metadata
from app.config import get_settings
from app.db import dispose_engine, init_db
from app.middleware.idempotency import IdempotencyMiddleware
from app.middleware.rate_limit import RateLimitMiddleware
from app.observability import init_sentry
from app.routers import (
    agents,
    analytics,
    api_keys,
    auth,
    consensus,
    disputes,
    escrows,
    governance,
    predictions,
    validators,
    webhooks,
)
from app.services.consensus import ChainUnavailableError
from app.services.genlayer_indexer import run_forever as run_chain_indexer

settings = get_settings()
logger = logging.getLogger(__name__)

# Before the FastAPI app is built below — see init_sentry's own docstring
# on why. A no-op unless SENTRY_DSN is actually set (ROADMAP.md 6.3).
init_sentry(settings)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Startup: create tables that don't exist yet (see db.init_db's
    # docstring re: this being a placeholder for Alembic).
    await init_db()

    # The chain indexer (services/genlayer_indexer.py) as a background
    # task sharing this process/event loop, rather than a separate
    # `python -m app.services.genlayer_indexer` terminal to babysit — one
    # fewer moving part in local dev and in a future container. Gated by
    # settings.enable_chain_indexer (default True) so
    # tests/conftest.py's autouse fixture can force it off for the whole
    # suite: every test instantiates the app via `with TestClient(app)`,
    # which runs this lifespan, and a real poll loop shelling out to
    # `npx tsx` per cycle has no business running during unit tests.
    indexer_task: asyncio.Task[None] | None = None
    if settings.enable_chain_indexer:
        indexer_task = asyncio.create_task(run_chain_indexer(), name="genlayer-chain-indexer")

    yield

    # Shutdown: cancel the indexer cleanly before tearing down the engine
    # it depends on — cancelling second (or not at all) would let it try a
    # DB write against an already-disposed pool. run_forever's own
    # try/except Exception around each cycle doesn't swallow this:
    # asyncio.CancelledError is a BaseException, not an Exception, so it
    # still propagates and stops the loop. genlayer_rpc.read_and_check
    # separately makes sure a cycle cancelled mid-subprocess kills that
    # child process too, rather than orphaning it.
    if indexer_task is not None:
        indexer_task.cancel()
        try:
            await indexer_task
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001 — shutdown must not crash on this
            logger.exception("genlayer-chain-indexer task raised during shutdown")

    await dispose_engine()


app = FastAPI(
    title="Nuance API",
    description="Backend for Nuance — AI-validator consensus for claims "
    "traditional smart contracts can't settle.",
    version="0.1.0",
    lifespan=lifespan,
)

# Starlette treats the *last* `add_middleware` call as outermost (it runs
# first on the way in) — so this order gives, outer to inner:
# CORS -> RateLimit -> Idempotency -> router. Rate limiting rejects before
# idempotency ever touches its own DB lookup, and CORS headers still land
# on the 429/409 responses either middleware can short-circuit with.
app.add_middleware(IdempotencyMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(api_keys.router)
app.include_router(webhooks.router)
app.include_router(escrows.router)
app.include_router(disputes.router)
app.include_router(consensus.router)
app.include_router(predictions.router)
app.include_router(governance.router)
app.include_router(validators.router)
app.include_router(agents.router)
app.include_router(analytics.router)


# Single registration point for ChainUnavailableError -> 503 — see that
# exception's own docstring (services/consensus.py) for why every write
# endpoint that can raise it (routers/escrows.py, disputes.py,
# predictions.py) deliberately does NOT catch it locally: registering the
# mapping once here means no future call site can forget it and let the
# error surface as an unhandled 500 instead.
@app.exception_handler(ChainUnavailableError)
async def chain_unavailable_handler(request: Request, exc: ChainUnavailableError) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
