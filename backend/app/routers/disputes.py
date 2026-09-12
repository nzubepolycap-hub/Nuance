"""GET/POST /disputes/{id}/messages (+ WS/SSE live variants), GET/POST
/disputes/{id}/evidence, GET /disputes, enforce.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import AsyncSessionLocal, get_db
from app.dependencies import get_current_user, require_user_with_scope
from app.enums import ConsensusStage, ConsensusSubjectType, StatusKey
from app.models import ConsensusJob, Dispute, DisputeEvidence, DisputeMessage, User
from app.schemas import (
    DisputeEnforceRequest,
    DisputeEvidenceCreate,
    DisputeEvidenceRead,
    DisputeMessageCreate,
    DisputeMessageRead,
    DisputeRead,
    OnChainEvidenceAck,
)
from app.services.consensus import ChainUnavailableError, run_consensus
from app.services.realtime import format_sse, publish_dispute_message, subscribe_dispute_messages
from app.services.webhooks import schedule_notify as schedule_webhook_notify

router = APIRouter(prefix="/disputes", tags=["disputes"])
logger = logging.getLogger(__name__)

MESSAGES_POLL_INTERVAL_SECONDS = 2.0


async def _get_dispute_or_404(dispute_id: int, db: AsyncSession) -> Dispute:
    result = await db.execute(
        select(Dispute)
        .where(Dispute.id == dispute_id)
        .options(selectinload(Dispute.evidence), selectinload(Dispute.messages))
    )
    dispute = result.scalar_one_or_none()
    if dispute is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dispute not found.")
    return dispute


async def _get_dispute_for_update_or_404(dispute_id: int, db: AsyncSession) -> Dispute:
    """Same as _get_dispute_or_404, but holds a row lock on the Dispute
    for the rest of this transaction (ROADMAP.md Part 3 5.4's double-
    release race, same reasoning as routers/escrows.py's
    _get_escrow_for_update_or_404/routers/governance.py's
    _get_proposal_for_update_or_404) — use for enforce_ruling
    specifically, which reads `dispute.resolved_at` then writes it in the
    same request: without a lock, two concurrent enforce_ruling calls can
    both pass the "not yet resolved" check before either commits, and
    both write a (possibly conflicting) ruling. A no-op on SQLite, a real
    lock on Postgres.
    """
    result = await db.execute(
        select(Dispute)
        .where(Dispute.id == dispute_id)
        .options(selectinload(Dispute.evidence), selectinload(Dispute.messages))
        .with_for_update()
    )
    dispute = result.scalar_one_or_none()
    if dispute is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dispute not found.")
    return dispute


@router.get("", response_model=list[DisputeRead])
async def list_disputes(db: AsyncSession = Depends(get_db)) -> list[Dispute]:
    result = await db.execute(
        select(Dispute)
        .options(selectinload(Dispute.evidence), selectinload(Dispute.messages))
        .order_by(Dispute.created_at.desc())
    )
    return list(result.scalars().all())


@router.get("/{dispute_id}", response_model=DisputeRead)
async def get_dispute(dispute_id: int, db: AsyncSession = Depends(get_db)) -> Dispute:
    return await _get_dispute_or_404(dispute_id, db)


# --- Messages -------------------------------------------------------------


@router.get("/{dispute_id}/messages", response_model=list[DisputeMessageRead])
async def list_messages(
    dispute_id: int,
    db: AsyncSession = Depends(get_db),
) -> list[DisputeMessage]:
    await _get_dispute_or_404(dispute_id, db)
    result = await db.execute(
        select(DisputeMessage)
        .where(DisputeMessage.dispute_id == dispute_id)
        .order_by(DisputeMessage.created_at.asc())
    )
    return list(result.scalars().all())


@router.post(
    "/{dispute_id}/messages",
    response_model=DisputeMessageRead,
    status_code=status.HTTP_201_CREATED,
)
async def send_message(
    dispute_id: int,
    payload: DisputeMessageCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DisputeMessage:
    dispute = await _get_dispute_or_404(dispute_id, db)
    msg = DisputeMessage(
        dispute_id=dispute.id,
        sender_address=current_user.wallet_address,
        content=payload.content,
    )
    db.add(msg)
    await db.commit()
    await db.refresh(msg)

    # Best-effort — see realtime.publish_update's own docstring: a publish
    # failure never breaks the request that triggered it, subscribers just
    # fall back to their own db-polling loop below instead of getting an
    # instant push.
    await publish_dispute_message(
        dispute_id, {"type": "message", "message": DisputeMessageRead.model_validate(msg).model_dump(mode="json")}
    )
    return msg


async def _list_messages_fresh(dispute_id: int) -> list[DisputeMessage] | None:
    """Same reasoning as routers/consensus.py's `_get_job_or_none` — a
    fresh session per call rather than one held for a WS/SSE connection's
    whole life, so SQLAlchemy's identity map can't keep handing back a
    stale row set across poll ticks. Returns None if the dispute itself
    doesn't exist (vs. an empty list, which just means no messages yet)."""
    async with AsyncSessionLocal() as db:
        dispute = await db.get(Dispute, dispute_id)
        if dispute is None:
            return None
        result = await db.execute(
            select(DisputeMessage)
            .where(DisputeMessage.dispute_id == dispute_id)
            .order_by(DisputeMessage.created_at.asc())
        )
        return list(result.scalars().all())


def _messages_init_payload(messages: list[DisputeMessage]) -> dict:
    return {
        "type": "init",
        "messages": [DisputeMessageRead.model_validate(m).model_dump(mode="json") for m in messages],
    }


@router.websocket("/ws/{dispute_id}/messages")
async def dispute_messages_ws(websocket: WebSocket, dispute_id: int) -> None:
    """Live counterpart to GET/POST /{dispute_id}/messages above — added
    2026-09-08 (ROADMAP.md Part 3 5.2's "live dispute-message updates over
    the same realtime channel"): dispute-detail-view.tsx used to have no
    push channel at all for chat messages, just a 3s setInterval poll.
    Mirrors routers/consensus.py's consensus_status_ws structure (subscribe
    *before* the initial read, so nothing published in between is missed;
    Redis pub/sub when reachable, db polling unchanged otherwise) — the
    one real difference is there's no terminal "DONE" state here: a
    dispute's chat never stops, so this loops until the client disconnects
    rather than until some stage is reached.
    """
    await websocket.accept()
    try:
        updates = await subscribe_dispute_messages(dispute_id)

        messages = await _list_messages_fresh(dispute_id)
        if messages is None:
            await websocket.send_json({"error": "Dispute not found."})
            await websocket.close(code=1008)
            return

        await websocket.send_json(_messages_init_payload(messages))

        if updates is not None:
            async for payload in updates:
                await websocket.send_json(payload)
            return

        # Redis unavailable — poll for messages newer than the last one
        # already sent, unchanged in spirit from the frontend's own old
        # setInterval loop, just server-side now.
        last_id = messages[-1].id if messages else 0
        while True:
            await asyncio.sleep(MESSAGES_POLL_INTERVAL_SECONDS)
            fresh = await _list_messages_fresh(dispute_id)
            if fresh is None:
                await websocket.send_json({"error": "Dispute not found."})
                await websocket.close(code=1008)
                return
            new_messages = [m for m in fresh if m.id > last_id]
            if new_messages:
                for m in new_messages:
                    await websocket.send_json(
                        {"type": "message", "message": DisputeMessageRead.model_validate(m).model_dump(mode="json")}
                    )
                last_id = new_messages[-1].id
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 — never let a bad tick crash the server, just drop this connection
        logger.exception("Dispute messages WS tick failed for dispute %s", dispute_id)
        try:
            await websocket.close(code=1011)
        except RuntimeError:
            pass  # already closed


async def _dispute_messages_sse_events(dispute_id: int) -> AsyncIterator[str]:
    """SSE counterpart to dispute_messages_ws — see routers/consensus.py's
    _consensus_sse_events for why this is factored out as its own
    generator (directly testable) and ROADMAP.md Part 3 5.2 for why SSE
    exists as a fallback tier at all. No terminal event here (unlike
    consensus's `event: done`) — a dispute's chat has no "finished" state,
    so this streams until the client disconnects, same as the WS variant."""
    updates = await subscribe_dispute_messages(dispute_id)

    messages = await _list_messages_fresh(dispute_id)
    if messages is None:
        yield format_sse({"error": "Dispute not found."})
        return

    yield format_sse(_messages_init_payload(messages))

    if updates is not None:
        async for payload in updates:
            yield format_sse(payload)
        return

    last_id = messages[-1].id if messages else 0
    while True:
        await asyncio.sleep(MESSAGES_POLL_INTERVAL_SECONDS)
        fresh = await _list_messages_fresh(dispute_id)
        if fresh is None:
            yield format_sse({"error": "Dispute not found."})
            return
        new_messages = [m for m in fresh if m.id > last_id]
        for m in new_messages:
            yield format_sse({"type": "message", "message": DisputeMessageRead.model_validate(m).model_dump(mode="json")})
        if new_messages:
            last_id = new_messages[-1].id


@router.get("/sse/{dispute_id}/messages")
async def dispute_messages_sse(dispute_id: int) -> StreamingResponse:
    return StreamingResponse(
        _dispute_messages_sse_events(dispute_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- Evidence -------------------------------------------------------------


@router.get("/{dispute_id}/evidence", response_model=list[DisputeEvidenceRead])
async def list_evidence(
    dispute_id: int,
    db: AsyncSession = Depends(get_db),
) -> list[DisputeEvidence]:
    await _get_dispute_or_404(dispute_id, db)
    result = await db.execute(
        select(DisputeEvidence)
        .where(DisputeEvidence.dispute_id == dispute_id)
        .order_by(DisputeEvidence.created_at.asc())
    )
    return list(result.scalars().all())


@router.post(
    "/{dispute_id}/evidence",
    response_model=DisputeEvidenceRead,
    status_code=status.HTTP_201_CREATED,
)
async def submit_evidence(
    dispute_id: int,
    payload: DisputeEvidenceCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    # ROADMAP.md Part 4 6.1 — see routers/escrows.py::create_escrow's own
    # note on require_user_with_scope.
    current_user: User = Depends(require_user_with_scope("evidence:submit")),
) -> DisputeEvidenceRead:
    dispute = await _get_dispute_or_404(dispute_id, db)
    # This exact endpoint used to be the real, shipped bug documented on
    # submit_evidence_on_chain's own docstring below: every dispute's
    # evidence, on-chain-filed or not, went through this off-chain
    # ConsensusJob path with no guard. Refuses now — see
    # ChainUnavailableError's own docstring.
    if dispute.on_chain_tx_hash is not None:
        raise ChainUnavailableError(
            f"Dispute {dispute_id} was filed on-chain (tx {dispute.on_chain_tx_hash}) "
            f"— use POST /disputes/{dispute_id}/evidence/on-chain instead of this "
            "off-chain endpoint."
        )
    evidence = DisputeEvidence(
        dispute_id=dispute.id,
        submitter_address=current_user.wallet_address,
        description=payload.description,
        link=payload.link,
    )
    db.add(evidence)

    # Queued synchronously so the 201 response can hand back a real job_id;
    # the LLM deliberation itself runs after the response is sent.
    job = ConsensusJob(
        subject_type=ConsensusSubjectType.DISPUTE,
        subject_id=dispute.id,
        stage=int(ConsensusStage.IDLE),
    )
    db.add(job)

    await db.commit()
    await db.refresh(evidence)
    await db.refresh(job)

    background_tasks.add_task(
        run_consensus, ConsensusSubjectType.DISPUTE, dispute.id, payload.description
    )

    return DisputeEvidenceRead(
        id=evidence.id,
        dispute_id=evidence.dispute_id,
        submitter_address=evidence.submitter_address,
        description=evidence.description,
        link=evidence.link,
        created_at=evidence.created_at,
        consensus_job_id=job.id,
    )


@router.post(
    "/{dispute_id}/evidence/on-chain",
    response_model=DisputeEvidenceRead,
    status_code=status.HTTP_201_CREATED,
)
async def submit_evidence_on_chain(
    dispute_id: int,
    payload: OnChainEvidenceAck,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DisputeEvidenceRead:
    """The on-chain counterpart to submit_evidence above — reached once
    components/app/genlayer-write-client.ts's addEvidenceOnChain has
    already signed and sent a real NuanceDisputeCourt.add_evidence
    transaction. Added 2026-09-08 to close the actual gap that caused a
    real bug: before this endpoint existed, submitting evidence for ANY
    dispute — on-chain or not — always went through submit_evidence
    above, which always queues an off-chain ConsensusJob. That silently
    routed an on-chain-filed dispute's ruling through Nuance's own
    off-chain AI review instead of real GenVM validators, with nothing
    in the UI making the swap visible (found live, see contracts/
    nuance_dispute_court.py's add_evidence docstring for the full
    account).

    Unlike submit_evidence, this does NOT queue a ConsensusJob — real
    judgment happens via adjudicate_dispute on the contract itself
    (services/genlayer_indexer.py's trigger_pending_adjudications
    triggers it automatically once the dispute is open and matched).
    Still creates a local DisputeEvidence row purely so the evidence
    shows up in the UI's evidence list — same "not a trust boundary"
    reasoning as every other on-chain ack in this app: nothing here
    verifies the hash is real or that the contract call actually
    succeeded; only the indexer reading the contract's own ruling back
    is what actually matters.
    """
    dispute = await _get_dispute_or_404(dispute_id, db)
    evidence = DisputeEvidence(
        dispute_id=dispute.id,
        submitter_address=current_user.wallet_address,
        description=f"On-chain evidence submitted (tx {payload.tx_hash}).",
        link=payload.evidence_url,
    )
    db.add(evidence)
    await db.commit()
    await db.refresh(evidence)

    return DisputeEvidenceRead(
        id=evidence.id,
        dispute_id=evidence.dispute_id,
        submitter_address=evidence.submitter_address,
        description=evidence.description,
        link=evidence.link,
        created_at=evidence.created_at,
        consensus_job_id=None,
    )


# --- Enforce Ruling -------------------------------------------------------


@router.post("/{dispute_id}/enforce", response_model=DisputeRead)
async def enforce_ruling(
    dispute_id: int,
    payload: DisputeEnforceRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Dispute:
    dispute = await _get_dispute_for_update_or_404(dispute_id, db)
    if dispute.resolved_at is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Dispute already enforced.")

    dispute.status_key = StatusKey.APPROVED if payload.approved else StatusKey.DISPUTED
    dispute.ruling = payload.ruling
    dispute.enforced_by = current_user.wallet_address
    dispute.resolved_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(dispute, attribute_names=["evidence", "messages"])

    # Fire-and-forget (services/webhooks.py's own contract) — never delays
    # or fails this response.
    schedule_webhook_notify(
        "dispute.resolved",
        {
            "dispute_id": dispute.id,
            "escrow_id": dispute.escrow_id,
            "status_key": dispute.status_key.value,
            "ruling": dispute.ruling,
            "enforced_by": dispute.enforced_by,
        },
    )
    return dispute
