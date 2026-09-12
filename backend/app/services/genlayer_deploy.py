"""Auto-deploys a real NuanceEscrow or NuancePredictionMarket instance for
a new escrow/market — the last piece Part 2 needed. Closes the gap
scripts/deploy.ts's own header called out from the start: bootstrap
deployments prove the contracts work, but "a new escrow between two real
users still needs its own fresh deployment with their real data, called
from the app itself once that wiring exists (a Step 4/backend-integration
concern)" — the exact same reasoning applies to prediction markets.

Three layers, same split as genlayer_rpc.py/genlayer_indexer.py:
  - deploy_contract(): a pure subprocess bridge to scripts/genlayer-deploy.ts
    (no DB access) — mirrors genlayer_rpc.read_and_check's shape exactly.
  - deploy_escrow_contract(): the DB-aware orchestration routers/escrows.py
    queues as a background task right after a new escrow is created.
  - deploy_prediction_contract(): the equivalent for a new market,
    invoked from services/market_generator.py's _process_events for every
    market it auto-publishes.

Deliberately server-side, not wallet-signed from the browser like
submitDeliverableOnChain/fileDisputeOnChain/betOnChain (components/app/
genlayer-write-client.ts) are: deploying needs the contract source's raw
bytes, which a browser bundle has no reason to ship, and
GENLAYER_PRIVATE_KEY was never meant to reach client-side JS — the exact
same key scripts/deploy.ts's bootstrap deployments already use, loaded the
exact same way (from backend/.env).
"""

from __future__ import annotations

import asyncio
import json
import logging
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.db import AsyncSessionLocal
from app.models import Escrow, Prediction
from app.services.genlayer_rpc import _repo_root

logger = logging.getLogger(__name__)

# GEN has 18 decimals — same fact components/app/genlayer-chain.ts's
# WEI_PER_GEN is pulled from (GENLAYER_BRADBURY.nativeCurrency.decimals).
_WEI_PER_GEN_EXPONENT = 18


def _gen_to_wei(amount: Decimal) -> int:
    """Exact Decimal GEN -> integer wei conversion, done off the Decimal's
    own digit tuple rather than `int(amount * 10**18)` — same string-safe
    reasoning genlayer-chain.ts's parseGenToWei documents (never floating
    point, and immune to Decimal's ambient context precision, which a
    naive multiply-then-round could clip for a large-enough amount).
    Replaces this file's old `escrow.total * 100` cents-style encoding —
    stale leftover from before the dollar-removal pass, and on a
    completely different scale than fund_escrow's real wei `value`, which
    made release_milestone's `milestone.amount > self.funded_amount` check
    compare numbers that were never on the same footing to begin with."""
    sign, digits, exponent = amount.as_tuple()
    if not isinstance(exponent, int):
        raise ValueError(f"Cannot convert non-finite Decimal {amount!r} to wei.")
    unscaled = int("".join(map(str, digits)))
    if sign:
        unscaled = -unscaled
    # amount == unscaled * 10**exponent; wei = amount * 10**18
    return unscaled * (10 ** (_WEI_PER_GEN_EXPONENT + exponent))


def _bigint_arg(value: int) -> dict:
    """Wraps a large integer constructor/call arg so it survives the JSON
    round-trip to scripts/genlayer-deploy.ts intact.

    Real bug this avoids: json.dumps(value) for a plain Python int emits a
    bare JSON number literal, and JS's JSON.parse turns any such literal
    into a `number` — an IEEE-754 double, exact only up to 2**53. A wei
    amount at GEN's 18-decimal scale (order 10**18-10**21 here) is always
    past that, so it would silently round to the nearest representable
    double before genlayer-js's own calldata encoder ever sees it (its
    encoder's `case "bigint"` branch IS exact — see node_modules/
    genlayer-js/dist/index.js's encodeImpl — but only if what reaches it
    is already a real JS BigInt, not a `number` that's already lossy).
    This `{"__bigint__": "<digits>"}` shape is what genlayer-deploy.ts's
    JSON.parse reviver looks for and converts back into a true BigInt
    before it ever becomes a `number` — the string in between carries
    arbitrary digit counts exactly, the same reasoning safeStringify
    (scripts/genlayer-deploy-core.ts) already applies in the opposite
    direction for BigInt fields coming back out."""
    return {"__bigint__": str(value)}

_SCRIPT_PATH = _repo_root() / "scripts" / "genlayer-deploy.ts"

# A deploy can take up to ~3 minutes (scripts/genlayer-deploy-core.ts's own
# 60-retry, 3s-interval receipt wait) — this is a belt-and-suspenders cap
# well above that, not a tight timeout; the underlying engine's own bounded
# retries are what actually end the subprocess in the normal case.
_DEPLOY_TIMEOUT_SECONDS = 360


async def deploy_contract(file: str, args: list) -> str | None:
    """Deploys contracts/<file> with `args` via scripts/genlayer-deploy.ts
    and returns the deployed address, or None if the deploy failed —
    logged, never raised. Callers treat None exactly like any other
    pre-cutover row: stay on the legacy off-chain path, no special error
    handling needed at the call site.
    """
    payload = json.dumps({"file": file, "args": args}).encode("utf-8")

    try:
        proc = await asyncio.create_subprocess_exec(
            "npx",
            "tsx",
            str(_SCRIPT_PATH),
            cwd=str(_repo_root()),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as exc:
        logger.error("genlayer-deploy subprocess failed to start: %s", exc)
        return None

    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(payload), timeout=_DEPLOY_TIMEOUT_SECONDS
        )
    except asyncio.CancelledError:
        # Same reasoning as genlayer_rpc.read_and_check's own handling:
        # cancellation (e.g. server shutdown mid-deploy) must not orphan
        # the child process.
        proc.kill()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except (TimeoutError, asyncio.TimeoutError):
            logger.warning("genlayer-deploy subprocess (pid=%s) didn't exit after kill()", proc.pid)
        raise
    except (TimeoutError, asyncio.TimeoutError):
        logger.error(
            "genlayer-deploy for %s exceeded %ss — killing it. This should only "
            "happen if the underlying deploy engine's own bounded retries somehow "
            "didn't (see genlayer-deploy-core.ts).",
            file,
            _DEPLOY_TIMEOUT_SECONDS,
        )
        proc.kill()
        return None

    if proc.returncode != 0:
        logger.error(
            "genlayer-deploy exited %s: %s", proc.returncode, stderr.decode("utf-8", "replace")[-2000:]
        )
        return None

    try:
        parsed = json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError:
        logger.error("genlayer-deploy produced non-JSON stdout: %r", stdout[:2000])
        return None

    if not parsed.get("ok"):
        logger.error("Contract deploy failed for %s: %s", file, parsed.get("error"))
        return None

    return parsed.get("address")


async def deploy_escrow_contract(escrow_id: int) -> None:
    """Background task routers/escrows.py::create_escrow queues right
    after a new escrow is committed. Deploys a fresh NuanceEscrow instance
    with that escrow's real counterparty/milestone data and links it
    (Escrow.contract_address + the milestone's on_chain_index) — from this
    point on, components/app/nuance-app.tsx's submitDeliverable/
    escalateToDisputeCourt see a real linked contract and route through
    the on-chain path automatically, no --link-demo needed.

    Runs its own DB session — same reasoning services/consensus.py's
    run_consensus module docstring gives: this executes after the request
    that queued it has already returned, on its own timeline (up to a few
    minutes). A failed or still-in-flight deploy simply leaves the escrow
    off-chain, same as any pre-cutover row — never a user-facing error.
    """
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Escrow)
            .where(Escrow.id == escrow_id)
            .options(selectinload(Escrow.milestones), selectinload(Escrow.asset))
        )
        escrow = result.scalar_one_or_none()
        if escrow is None:
            logger.warning("deploy_escrow_contract: escrow id=%s no longer exists.", escrow_id)
            return
        if escrow.contract_address is not None:
            return  # already linked — a duplicate/retry queue, not an error

        # FOUND 2026-09-10 (integration audit) — this function had no idea
        # ROADMAP.md Part 4 6.2's Asset model existed at all: it always
        # ran _gen_to_wei (a fixed 18-decimal GEN conversion) on the
        # milestone amount and deployed a contract whose fund_escrow only
        # ever accepts native currency (gl.message.value — see contracts/
        # nuance_escrow.py; there is no ERC-20 transfer path anywhere in
        # this contract or components/app/genlayer-write-client.ts). A
        # non-native escrow (e.g. the seeded testnet USDC, 6 decimals) —
        # not creatable from the UI yet, but very much creatable today via
        # a direct POST /escrows call or the SDK (EscrowCreate.asset_
        # symbol) — would have been deployed with an amount that's wrong
        # by 12 orders of magnitude and no real way to ever fund it in the
        # asset it's actually denominated in. Skip auto-deploy entirely
        # for a non-native asset; it stays on the (asset-agnostic —
        # release_milestone does no unit conversion at all) legacy
        # off-chain path until this contract actually supports a second
        # settlement asset.
        if not escrow.asset.is_native:
            logger.info(
                "deploy_escrow_contract: escrow id=%s is denominated in %s, not native GEN — "
                "NuanceEscrow only supports native-currency funding today, staying off-chain.",
                escrow_id,
                escrow.asset.symbol,
            )
            return

        milestone = min(escrow.milestones, key=lambda m: m.order_index, default=None)
        if milestone is None:
            logger.warning(
                "deploy_escrow_contract: escrow id=%s has no milestone to deploy against.",
                escrow_id,
            )
            return

        # NuanceEscrow's milestone_amount is a u256, real wei — matching
        # exactly what components/app/genlayer-write-client.ts's
        # fundEscrowOnChain sends as fund_escrow's payable value (via
        # parseGenToWei), and what release_milestone's own
        # `milestone.amount > self.funded_amount` check compares it
        # against. Both sides of that comparison have to be on the same
        # footing — see _gen_to_wei's own docstring for the stale "cents"
        # encoding this replaces, which wasn't.
        amount_wei = _gen_to_wei(milestone.amount)

        address = await deploy_contract(
            "nuance_escrow.py",
            [
                escrow.creator_address,
                escrow.counterparty_address,
                milestone.name,
                _bigint_arg(amount_wei),
                milestone.criteria,
            ],
        )
        if address is None:
            logger.error(
                "Auto-deploy failed for escrow id=%s — it stays on the legacy off-chain path.",
                escrow_id,
            )
            return

        escrow.contract_address = address
        milestone.on_chain_index = 0
        await db.commit()
        logger.info("Auto-deployed NuanceEscrow for escrow id=%s -> %s", escrow_id, address)


async def deploy_prediction_contract(prediction_id: int) -> None:
    """Two callers, two different "pending_review" meanings:

    - services/market_generator.py's _process_events, for every market it
      auto-publishes (auto_publish=True, immediately "open" — a
      "pending_review" DRAFT from that pipeline is never passed here at
      all; it might still be discarded/edited before a human makes it
      live, and spending real testnet GEN deploying a contract for a
      market that may never launch isn't worth it). Retired 2026-09-12 in
      favor of the path below, but left in place rather than deleted.
    - routers/predictions.py's create_prediction (2026-09-12 rebrand: a
      real person authoring a real market, replacing the pipeline above).
      Every market from there STARTS "pending_review" on purpose — see
      that endpoint's own docstring — specifically so this function can
      deploy it: on success, this flips it to "open" (the case handled
      right below), which is what actually makes it visible/bettable.
      Before this fix, only market_generator's callers ever set
      contract_address; a create_prediction market that deployed
      successfully would have stayed invisible forever with a real
      contract nobody could reach.

    Either way: deploys a fresh NuancePredictionMarket instance with that
    market's real question/resolution data and links it (Prediction.
    contract_address) — from this point on, components/app/nuance-app.tsx's
    placeBet/resolveMarket see a real linked contract and route through
    the on-chain path automatically.

    Skips (logs, doesn't fail) a market with no resolution_source_url —
    NuancePredictionMarket.resolve_market's whole judgment depends on
    fetching that URL (gl.nondet.web.get(), see that contract's own fix
    note), and a market with nothing to check against can't meaningfully
    resolve on-chain at all. create_prediction's own schema (PredictionCreate)
    already requires this field, so this branch is dead for that caller —
    kept for market_generator's, whose Prediction rows predate the
    requirement. Runs its own DB session — same reasoning
    deploy_escrow_contract gives.
    """
    async with AsyncSessionLocal() as db:
        prediction = await db.get(Prediction, prediction_id)
        if prediction is None:
            logger.warning("deploy_prediction_contract: prediction id=%s no longer exists.", prediction_id)
            return
        if prediction.contract_address is not None:
            return  # already linked — a duplicate/retry queue, not an error

        if not prediction.resolution_source_url:
            logger.info(
                "Skipping auto-deploy for prediction id=%s — no resolution_source_url to "
                "resolve against; staying on the legacy off-chain path.",
                prediction_id,
            )
            return

        address = await deploy_contract(
            "nuance_prediction_market.py",
            [
                prediction.title,
                prediction.resolution_source_url,
                prediction.description,
                prediction.resolution_date.isoformat(),
            ],
        )
        if address is None:
            logger.error(
                "Auto-deploy failed for prediction id=%s — it stays on the legacy "
                "off-chain path.",
                prediction_id,
            )
            return

        prediction.contract_address = address
        # See this function's own docstring — the actual create_prediction
        # activation step. Only ever flips pending_review->open, so this
        # is a no-op for market_generator's already-"open" auto-published
        # rows (harmless either way, checked explicitly rather than
        # unconditionally overwriting status_key so this function never
        # clobbers some other state a market might be in by the time its
        # background deploy finally lands).
        if prediction.status_key == "pending_review":
            prediction.status_key = "open"
        await db.commit()
        logger.info("Deployed NuancePredictionMarket for prediction id=%s -> %s", prediction_id, address)
