# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

# ACTUAL ROOT CAUSE (found 2026-09-06 via GenLayer Studio bisection — see
# nuance_dispute_court.py's header for the full account): a long comment
# block placed directly under the Depends line, with no blank line
# separating them, breaks GenVM's runner-comment parser on every
# contract, independent of the hash or the contract body. The blank line
# above this paragraph is the fix; the hash below was never actually the
# problem despite an earlier round changing it.
#
# Nuance Prediction Market — Part 2, Step 2 (2 of 2). One contract
# instance per market — mirrors both the official Prediction Market docs
# example and backend/app/models/core.py's one-row-per-Prediction shape,
# unlike Dispute Court's shared registry.
#
# Sources & confidence: same citation list as nuance_escrow.py's header
# (football_bets.py, the equivalence-principle page) plus, specifically
# for this file, docs.genlayer.com's own official Prediction Market
# example, fetched verbatim 2026-09-05.
#
# One real gap found researching this file specifically: there is no
# documented on-chain clock/timestamp primitive — searched explicitly for
# gl.message.timestamp / block time / current time and found nothing, and
# GenLayer's own official Prediction Market example doesn't enforce a
# cutoff programmatically either. It just tells the LLM "if it says
# kickoff time, the game hasn't started" and lets the AI judge readiness
# from the source page's own content, not a stored clock. This file
# follows that same real, officially-used pattern: cutoff_time is stored
# and fed into the resolution prompt as context; bet()'s only *enforced*
# gate is `state == "OPEN"` (a field this contract fully controls) rather
# than comparing against a time source that may not exist. If GenLayer
# does expose a verified clock by the time this actually deploys, betting
# should hard-check it too — flagged here rather than guessed at.
#
# emit_transfer's real call shape (gl.get_contract_at(addr).emit_transfer(
# value=u256(...), on="finalized")) was confirmed against the live SDK
# after nuance_escrow.py's first draft — used as-is in claim_winnings
# below, sending to a plain wallet address exactly as it's used there.

from genlayer import *


class NuancePredictionMarket(gl.Contract):
    question: str
    resolution_url: str
    resolution_criteria: str
    cutoff_time: str  # informational/prompt context only — see header note
    total_yes_stake: u256
    total_no_stake: u256
    state: str  # "OPEN" | "RESOLVED"
    winning_outcome: str  # "" until resolved, then exactly "YES" | "NO"
    stakes_yes: TreeMap[Address, u256]
    stakes_no: TreeMap[Address, u256]
    # u256, not bool: a live Bradbury deploy (2026-09-06) came back
    # FINISHED_WITH_ERROR specifically on `self.claimed = TreeMap()` —
    # debugTraceTransaction's stderr showed
    # `AssertionError: Is right the same storage type? TreeMap <- TreeMap`
    # in genlayer/py/storage/_internal/desc_record.py, while the two
    # TreeMap[Address, u256] fields right above assigned fine in the same
    # __init__. Isolated to the bool value type specifically (not the
    # Address key type, which those two already exercise successfully) —
    # a bare `TreeMap()`'s runtime type descriptor doesn't match a
    # declared TreeMap[..., bool] the way it matches TreeMap[..., u256] or
    # TreeMap[..., a dataclass] (nuance_escrow.py/nuance_dispute_court.py's
    # own TreeMaps, both proven live on Bradbury). Worked around by storing
    # 0/1 instead of False/True — every read site below converts back to
    # a real bool at the point it leaves contract storage (get_my_stake's
    # return dict), so nothing outside this file sees the difference.
    #
    # UPDATE (nuance_governance.py, same day): this turned out to be one
    # instance of a broader rule, not a bool-specific quirk — a contract
    # can only have ONE distinct TreeMap[K, V] shape at all; introducing a
    # SECOND shape breaks the same way regardless of whether bool is
    # involved. See that file's header for the fuller account. Harmless
    # here since this contract's three TreeMaps are two-of-one-shape (this
    # workaround) rather than genuinely two different shapes, but worth
    # knowing before adding a fourth TreeMap field to this file.
    claimed: TreeMap[Address, u256]

    def __init__(
        self,
        question: str,
        resolution_url: str,
        resolution_criteria: str,
        cutoff_time: str,
    ):
        """Correction (2026-09-06, third round): stakes_yes/stakes_no/
        claimed are instantiated as bare `TreeMap()`, not
        `TreeMap[Address, u256]()` — see nuance_dispute_court.py's
        __init__ for why the subscripted form is an actual runtime
        TypeError in GenVM (a live deploy came back FINISHED_WITH_ERROR /
        all validators DISAGREE against it). The bracket form stays on
        each class-level annotation above — only a type hint — not on
        these instantiations."""
        self.question = question
        self.resolution_url = resolution_url
        self.resolution_criteria = resolution_criteria
        self.cutoff_time = cutoff_time
        self.total_yes_stake = 0
        self.total_no_stake = 0
        self.state = "OPEN"
        self.winning_outcome = ""
        self.stakes_yes = TreeMap()
        self.stakes_no = TreeMap()
        self.claimed = TreeMap()

    @gl.public.write.payable
    def bet(self, outcome: str) -> None:
        if self.state != "OPEN":
            raise gl.vm.UserError("This market is not open for betting.")
        side = outcome.strip().upper()
        if side not in ("YES", "NO"):
            raise gl.vm.UserError("outcome must be 'YES' or 'NO'.")
        if gl.message.value <= 0:
            raise gl.vm.UserError("Bet must include a nonzero stake.")

        sender = gl.message.sender_address
        if side == "YES":
            self.stakes_yes[sender] = self.stakes_yes.get(sender, 0) + gl.message.value
            self.total_yes_stake += gl.message.value
        else:
            self.stakes_no[sender] = self.stakes_no.get(sender, 0) + gl.message.value
            self.total_no_stake += gl.message.value

    @gl.public.write
    def resolve_market(self) -> None:
        if self.state != "OPEN":
            raise gl.vm.UserError("This market has already been resolved.")

        question = self.question
        criteria = self.resolution_criteria
        cutoff_time = self.cutoff_time
        resolution_url = self.resolution_url

        def leader_fn() -> dict:
            # FIXED 2026-09-11 — same bug, same fix as nuance_escrow.py's
            # submit_deliverable (see that file's own note for the full
            # account): gl.nondet.web.render() was CONFIRMED LIVE
            # (2026-09-08) to reliably produce LEADER_TIMEOUT on Bradbury;
            # nuance_dispute_court.py's add_evidence already carries the
            # fix, this file never got it. gl.nondet.web.get() is the
            # verified-working replacement — wrapped in try/except and
            # truncated to 3000 chars for the same reasons: an
            # unreachable/slow source page must not hang the whole
            # resolution instead of just failing this attempt honestly.
            try:
                response = gl.nondet.web.get(resolution_url)
                web_data = response.body.decode("utf-8", errors="replace")[:3000]
            except Exception as exc:
                web_data = f"(Resolution source URL was unreachable or timed out: {exc})"

            prompt = f"""You are resolving a binary prediction market.

Question: {question}
Resolution criteria: {criteria}
Cutoff / expected resolution time: {cutoff_time}

Source page content:
{web_data}

Decide whether the question resolves YES or NO based only on the source
content above. If the source doesn't yet contain enough information to
resolve it — including if it indicates the cutoff time hasn't actually
been reached yet — set "resolved" to false rather than guessing. Respond
in JSON:
{{
    "resolved": bool,
    "outcome": str,
    "confidence": int,
    "reasoning": str
}}
"outcome" must be exactly "YES" or "NO" and is only meaningful when
resolved is true. It is mandatory that you respond only using the JSON
format above, nothing else. Don't include any other words or characters,
your output must be perfectly parsable by a JSON parser without errors."""
            return gl.nondet.exec_prompt(prompt, response_format="json")

        # Partial-field matching: validators must agree on both whether
        # it's resolved and which way — not on confidence/reasoning.
        def validator_fn(leader_result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                return False
            own = leader_fn()
            leader_data = leader_result.calldata
            return bool(own["resolved"]) == bool(leader_data["resolved"]) and str(
                own.get("outcome", "")
            ) == str(leader_data.get("outcome", ""))

        verdict = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)

        if not bool(verdict["resolved"]):
            raise gl.vm.UserError("Not resolvable yet: " + str(verdict.get("reasoning", "")))

        self.state = "RESOLVED"
        self.winning_outcome = str(verdict["outcome"]).strip().upper()

    @gl.public.write
    def claim_winnings(self) -> None:
        """Not in the original spec (which only named bet() and
        resolve_market()) — added because a market that can never actually
        pay anyone isn't complete. Pull-based on purpose: each bettor
        claims their own share individually rather than resolve_market
        trying to pay every bettor in one pass — an unbounded loop over an
        arbitrarily large TreeMap inside a single consensus-wrapped write
        is a real gas/DoS risk this avoids entirely."""
        if self.state != "RESOLVED":
            raise gl.vm.UserError("This market has not resolved yet.")

        sender = gl.message.sender_address
        if self.claimed.get(sender, 0):
            raise gl.vm.UserError("Already claimed.")

        won_yes = self.winning_outcome == "YES"
        winning_pool = self.total_yes_stake if won_yes else self.total_no_stake
        losing_pool = self.total_no_stake if won_yes else self.total_yes_stake
        my_stake = (self.stakes_yes if won_yes else self.stakes_no).get(sender, 0)
        if my_stake == 0:
            raise gl.vm.UserError("No winning stake to claim.")

        # Pari-mutuel payout — same math as backend/app/services/payout.py's
        # off-chain calculate_prediction_payouts: your share of the losing
        # pool is proportional to your share of the winning pool, on top
        # of your own stake back.
        payout = my_stake
        if winning_pool > 0:
            payout += (my_stake * losing_pool) // winning_pool

        self.claimed[sender] = 1
        recipient = gl.get_contract_at(sender)
        recipient.emit_transfer(value=u256(payout), on="finalized")

    @gl.public.view
    def get_market(self) -> dict:
        return {
            "question": self.question,
            "resolution_url": self.resolution_url,
            "resolution_criteria": self.resolution_criteria,
            "cutoff_time": self.cutoff_time,
            "total_yes_stake": self.total_yes_stake,
            "total_no_stake": self.total_no_stake,
            "state": self.state,
            "winning_outcome": self.winning_outcome,
        }

    @gl.public.view
    def get_my_stake(self, address: str) -> dict:
        addr = Address(address)
        return {
            "yes": self.stakes_yes.get(addr, 0),
            "no": self.stakes_no.get(addr, 0),
            "claimed": bool(self.claimed.get(addr, 0)),
        }
