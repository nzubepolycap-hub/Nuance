# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

# ACTUAL ROOT CAUSE (found 2026-09-06 via GenLayer Studio bisection — see
# nuance_dispute_court.py's header for the full account): a long comment
# block placed directly under the Depends line, with no blank line
# separating them, breaks GenVM's runner-comment parser on every
# contract, independent of the hash or the contract body. The blank line
# above this paragraph is the fix; the hash below was never actually the
# problem despite an earlier round changing it.
#
# Nuance Escrow — Part 2, Step 1.
#
# This is the on-chain replacement for backend/app/services/consensus.py's
# MILESTONE path: today that's a FastAPI background task calling Gemini/
# Anthropic/OpenAI directly and writing the verdict to our own database
# (see ROADMAP.md 4.1). Here, the same "was this deliverable good enough"
# judgment happens inside GenVM itself, decided by an independent validator
# committee via the equivalence principle, not by our backend.
#
# --- Sources & confidence (read before trusting this against training
# data or ROADMAP.md's own illustrative 4.3 skeleton, which the roadmap
# explicitly warns is unverified) ---
#
# VERIFIED against real, verbatim source, fetched 2026-09-05:
#   - genlayerlabs/genlayer-project-boilerplate's actual contracts/
#     football_bets.py (the Depends header, gl.Contract, @allow_storage +
#     @dataclass, TreeMap, gl.message.sender_address, gl.nondet.web.render,
#     gl.nondet.exec_prompt(..., response_format="json"),
#     gl.eq_principle.strict_eq, plain Exception for business errors).
#   - docs.genlayer.com's "Your First Intelligent Contract" and
#     "Prediction Market Contract" example pages (both examples agreed on
#     one Depends hash, which was assumed to be the current runner build —
#     it wasn't: the first real Bradbury deployment came back "ACCEPTED
#     (ERROR)" against it). Corrected here (updated 2026-09-06, after a
#     second contract's deploy attempt failed with "runner ... not found"
#     against py-genlayer:1zr6nqk597d97kg0dyxg0shhrykx5v02zjgnyrajapy4wlqvfvwh
#     — a hash this comment used to pin as "confirmed working," but that
#     was itself the round-1 red herring nuance_dispute_court.py's header
#     describes: switching the hash correlated with a real deploy attempt
#     but wasn't what fixed it. The Depends line actually at the top of
#     this file, py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6,
#     is what a live deployment actually confirmed works — this paragraph
#     previously claimed otherwise and was wrong; copy the header line
#     itself into a new contract, not a hash mentioned in prose.
#   - docs.genlayer.com's Equivalence Principle page, for
#     gl.vm.run_nondet_unsafe(leader_fn, validator_fn) and the "partial
#     field matching" pattern used below (validators only have to agree on
#     the decision field, not on prose/confidence).
#
# MODERATELY confirmed (two independent doc-search summaries agree, but I
# could not pull verbatim source — the "Working with Balances" docs page
# 404'd on every fetch): @gl.public.write.payable and gl.message.value.
# release_milestone's actual transfer call —
# gl.get_contract_at(addr).emit_transfer(value=u256(...), on="finalized")
# — was corrected from my original gl.ContractAt(...) guess against real
# verification; kept here for anyone reading only this header.
#
# NOT modeled here on purpose: PENDING/ACCEPTED/FINALIZED/APPEALED. Those
# are GenVM's own per-transaction consensus states (gen_getTransactionStatus),
# not something a contract stores about itself — see the chat discussion.
# This contract has its own, separate MilestoneStatus business field
# instead, mirroring backend/app/enums.py's StatusKey.

from genlayer import *
from dataclasses import dataclass


# --- Persistent types -------------------------------------------------


@allow_storage
@dataclass
class Milestone:
    name: str
    amount: u256
    criteria: str
    # "pending" | "in_review" | "approved" | "disputed" — this contract's
    # own business status, distinct from GenVM's transaction-level states
    # (see module docstring). Mirrors backend/app/enums.py's StatusKey.
    status: str
    released: bool
    deliverable_text: str
    deliverable_url: str
    # The winning validator committee's own stated reasoning — kept
    # on-chain for transparency/audit, same spirit as
    # ConsensusJob.verdict_reasoning in the off-chain path today.
    reasoning: str


# --- Contract -----------------------------------------------------------


class NuanceEscrow(gl.Contract):
    creator: Address
    counterparty: Address
    funded_amount: u256
    milestones: TreeMap[u256, Milestone]
    milestone_count: u256
    # "active" | "cancelled" — added 2026-09-08 alongside cancel_escrow().
    # Escrow-level, distinct from any individual Milestone.status: this
    # contract had no refund path at all before — if a milestone never got
    # approved (counterparty vanished, a dispute went the wrong way), the
    # creator's funded GEN sat here forever with no way out. See
    # cancel_escrow's own docstring for exactly what it does and doesn't
    # guard against.
    status: str

    def __init__(
        self,
        creator: str,
        counterparty: str,
        milestone_name: str,
        milestone_amount: u256,
        milestone_criteria: str,
    ):
        """One milestone at creation — deliberately mirrors the existing
        off-chain create_escrow (routers/escrows.py), which also always
        starts an escrow with exactly one milestone. Use add_milestone
        below for a second one, rather than accepting array-typed
        constructor args (unconfirmed whether GenVM constructors accept
        list-typed parameters directly; every real example I found took
        only scalar args).

        Correction (2026-09-06, third round): `milestones` is explicitly
        instantiated as bare `TreeMap()`, not `TreeMap[u256, Milestone]()`
        — see nuance_dispute_court.py's __init__ for why the subscripted
        form is an actual runtime TypeError in GenVM (a live deploy came
        back FINISHED_WITH_ERROR / all validators DISAGREE against it).
        The bracket form stays on the class-level annotation above — only
        a type hint — not on this instantiation.

        Correction (2026-09-08, real fund loss on live Bradbury): `creator`
        used to default to `gl.message.sender_address` — wrong, because
        every deploy of this contract is backend-signed (services/
        genlayer_deploy.py's deploy_escrow_contract uses this app's own
        GENLAYER_PRIVATE_KEY, never the real escrow creator's wallet). That
        made `self.creator` permanently equal to our backend's own service
        wallet, so fund_escrow/release_milestone/add_milestone — all
        creator-gated — rejected literally every real user, with no way to
        ever pass. Worse: GenVM does NOT refund the payable value attached
        to a call that a contract then rejects with gl.vm.UserError — the
        value transfers into the contract's balance before the business-
        logic check runs, permanently, with no withdrawal function to get
        it back out. A live test lost 1 real GEN into a contract deployed
        under the old constructor this exact way. `creator` is now an
        explicit constructor argument — deploy_escrow_contract passes the
        escrow's real creator_address — so this can't recur for any
        contract deployed after this fix. Already-deployed contracts from
        before this fix keep the wrong baked-in creator permanently; there
        is no upgrade path for a live GenVM contract."""
        self.creator = Address(creator)
        self.counterparty = Address(counterparty)
        self.funded_amount = 0
        self.milestones = TreeMap()
        self.milestone_count = 0
        self.status = "active"
        self._add_milestone(milestone_name, milestone_amount, milestone_criteria)

    def _add_milestone(self, name: str, amount: u256, criteria: str) -> u256:
        index = self.milestone_count
        self.milestones[index] = Milestone(
            name=name,
            amount=amount,
            criteria=criteria,
            status="pending",
            released=False,
            deliverable_text="",
            deliverable_url="",
            reasoning="",
        )
        self.milestone_count += 1
        return index

    @gl.public.write
    def add_milestone(self, name: str, amount: u256, criteria: str) -> u256:
        if gl.message.sender_address != self.creator:
            raise gl.vm.UserError("Only the escrow creator can add a milestone.")
        if self.status != "active":
            raise gl.vm.UserError(f"Escrow is '{self.status}' — cannot add a milestone.")
        return self._add_milestone(name, amount, criteria)

    # --- Funding ------------------------------------------------------
    #
    # MODERATE confidence — see module docstring. `@gl.public.write.payable`
    # is what makes a method able to receive value at all; gl.message.value
    # is how much GEN came in with this call.
    #
    # CONFIRMED the hard way (2026-09-08, real GEN lost on live Bradbury):
    # the sender check below runs AFTER gl.message.value has already
    # arrived — GenVM does not refund a payable call's attached value just
    # because the method body then raises. A wrong sender's GEN transfers
    # into this contract's balance regardless of the error, permanently
    # (no withdrawal function exists here). This is exactly why __init__'s
    # `creator` bug (see its own docstring) was so costly — every real
    # user's fund_escrow call failed this check while still paying in for
    # real. Keep any future creator-gated payable method's sender check
    # this same order (cheapest failure first) anyway; it doesn't change
    # this risk, but there's no reason to check late on top of it.

    @gl.public.write.payable
    def fund_escrow(self) -> None:
        if gl.message.sender_address != self.creator:
            raise gl.vm.UserError("Only the escrow creator can fund this escrow.")
        # Same GenVM quirk as the sender check above applies here too: if
        # the creator somehow calls fund_escrow after already cancelling
        # (an odd, deliberate sequence — the app's own UI never offers
        # this action once status is "cancelled") the attached GEN still
        # transfers in before this check runs and rejects it, with
        # nowhere for it to go back to. Kept anyway — a clear rejection
        # beats a cancelled escrow silently becoming fundable again — but
        # this is not a substitute for the frontend never presenting the
        # action in the first place.
        if self.status != "active":
            raise gl.vm.UserError(f"Escrow is '{self.status}' — cannot fund it.")
        self.funded_amount += gl.message.value

    # --- Deliverable submission + AI-validator consensus ----------------

    @gl.public.write
    def submit_deliverable(
        self, milestone_index: u256, deliverable_text: str, deliverable_url: str = ""
    ) -> None:
        if gl.message.sender_address != self.counterparty:
            raise gl.vm.UserError("Only the escrow counterparty can submit a deliverable.")
        if self.status != "active":
            raise gl.vm.UserError(f"Escrow is '{self.status}' — cannot submit a deliverable.")
        if milestone_index not in self.milestones:
            raise gl.vm.UserError("No such milestone.")

        milestone = self.milestones[milestone_index]
        if milestone.status not in ("pending", "disputed"):
            raise gl.vm.UserError(f"Milestone is '{milestone.status}', not open for submission.")

        milestone.deliverable_text = deliverable_text
        milestone.deliverable_url = deliverable_url
        criteria = milestone.criteria

        # Nondet blocks can't nest (docs.genlayer.com/.../non-determinism),
        # so the web fetch + LLM call both live inside the one leader_fn,
        # exactly like football_bets.py's own _check_match/get_match_result
        # closure — not as a separate pre-step outside the consensus block.
        def leader_fn() -> dict:
            # FIXED 2026-09-11 — was gl.nondet.web.render(deliverable_url,
            # mode="text"). That exact call shape was CONFIRMED LIVE
            # (2026-09-08, two separate real failed transactions) to
            # reliably produce LEADER_TIMEOUT (status 13) on live Bradbury
            # in this same project — see nuance_dispute_court.py's
            # add_evidence for the full account and the fix it already
            # got. That fix was never backported here; this milestone
            # review path carried the identical bug the whole time.
            # gl.nondet.web.get() (a plain HTTP GET, not render()'s
            # headless-browser-style full-page evaluation) is the
            # verified-working replacement. Wrapped in try/except and
            # truncated to 3000 chars for the same reasons as that fix:
            # an unreachable URL gets an honest note instead of hanging
            # the whole nondet block, and a huge page can't blow the
            # LLM's context budget.
            proof_context = "No linked proof URL was submitted."
            if deliverable_url:
                try:
                    response = gl.nondet.web.get(deliverable_url)
                    proof_context = response.body.decode("utf-8", errors="replace")[:3000]
                except Exception as exc:
                    proof_context = f"(Proof URL was unreachable or timed out: {exc})"

            prompt = f"""You are an impartial reviewer adjudicating a milestone
deliverable for an escrow agreement between two independent parties.

Agreed criteria:
{criteria}

Submitted deliverable text:
{deliverable_text}

Linked proof/evidence page content:
{proof_context}

Decide whether the deliverable satisfies the agreed criteria. Respond in
JSON:
{{
    "approved": bool,
    "confidence": int,
    "reasoning": str
}}
It is mandatory that you respond only using the JSON format above, nothing
else. Don't include any other words or characters, your output must be
perfectly parsable by a JSON parser without errors."""
            return gl.nondet.exec_prompt(prompt, response_format="json")

        # Partial-field-matching equivalence principle (docs.genlayer.com's
        # own pattern): every validator independently re-runs leader_fn and
        # only has to agree with the leader on `approved` — the actual
        # decision — not on the prose `reasoning` or the exact
        # `confidence` number, which are legitimately allowed to differ
        # between independent LLM calls asking the same qualitative
        # question. This is the on-chain equivalent of Nuance's existing
        # 3-validator majority vote (services/consensus.py's _aggregate),
        # just decided by GenVM's real validator committee instead of 3
        # API calls our own backend makes and grades itself.
        def validator_fn(leader_result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                return False
            own = leader_fn()
            leader_data = leader_result.calldata
            return bool(own["approved"]) == bool(leader_data["approved"])

        verdict = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)

        milestone.status = "approved" if bool(verdict["approved"]) else "disputed"
        milestone.reasoning = str(verdict.get("reasoning", ""))

    # --- Release ----------------------------------------------------------

    @gl.public.write
    def release_milestone(self, milestone_index: u256) -> None:
        if gl.message.sender_address != self.creator:
            raise gl.vm.UserError("Only the escrow creator can release milestone funds.")
        if self.status != "active":
            raise gl.vm.UserError(f"Escrow is '{self.status}' — cannot release funds.")
        if milestone_index not in self.milestones:
            raise gl.vm.UserError("No such milestone.")

        milestone = self.milestones[milestone_index]
        if milestone.status != "approved":
            raise gl.vm.UserError("This milestone has not been approved by consensus.")
        if milestone.released:
            raise gl.vm.UserError("This milestone has already been released.")
        if milestone.amount > self.funded_amount:
            raise gl.vm.UserError("Escrow is not funded for this milestone's amount.")

        milestone.released = True
        self.funded_amount -= milestone.amount
        # MODERATE confidence — see module docstring re: emit_transfer.
        recipient = gl.get_contract_at(self.counterparty)
        recipient.emit_transfer(value=u256(milestone.amount), on="finalized")

    # --- Cancellation / refund --------------------------------------------

    @gl.public.write
    def cancel_escrow(self) -> None:
        """The refund path this contract had no way to offer before
        2026-09-08 — added directly in response to real fund loss during
        the fund_escrow creator-bug incident (see __init__'s docstring):
        without this, ANY money genuinely stuck for ANY reason (a
        counterparty who vanishes, a milestone nobody ever approves) had
        no way back to the creator at all. Creator-only, matching every
        other lifecycle action here.

        Allowed only while no milestone has ever been approved. Once even
        one has, the counterparty has already delivered real,
        validator-approved work and has a legitimate claim on at least
        that milestone's share — cancellation past that point isn't a
        unilateral creator decision this contract makes on its own; that
        is exactly what NuanceDisputeCourt exists for instead.

        NOT enforced here (flagged rather than faked, same spirit as this
        codebase's other honest gaps — see nuance_prediction_market.py's
        header on cutoff_time): a "milestone deadline has passed" gate.
        There is no documented on-chain clock/timestamp primitive in
        GenVM for this contract to check a deadline against. If GenVM
        exposes a verified clock by the time this matters, add that
        check on top of this one — don't fake it with an unenforced
        parameter that looks like it does something it can't."""
        if gl.message.sender_address != self.creator:
            raise gl.vm.UserError("Only the escrow creator can cancel this escrow.")
        if self.status != "active":
            raise gl.vm.UserError(f"Escrow is already '{self.status}'.")

        # u256 loop via while/+=, not range()/int() — this exact pattern
        # (comparison, increment) is the only integer looping this
        # codebase has proven works on live GenVM; range() over a u256
        # storage value is unverified and not worth risking here.
        i: u256 = 0
        while i < self.milestone_count:
            if self.milestones[i].status == "approved":
                raise gl.vm.UserError(
                    "Cannot cancel — at least one milestone has already been approved. "
                    "Use release_milestone to pay it out, or file a dispute instead."
                )
            i += 1

        self.status = "cancelled"
        refund_amount = self.funded_amount
        self.funded_amount = 0
        if refund_amount > 0:
            # MODERATE confidence — see module docstring re: emit_transfer.
            recipient = gl.get_contract_at(self.creator)
            recipient.emit_transfer(value=u256(refund_amount), on="finalized")

    # --- Views ------------------------------------------------------------

    @gl.public.view
    def get_escrow(self) -> dict:
        return {
            "creator": self.creator.as_hex,
            "counterparty": self.counterparty.as_hex,
            "funded_amount": self.funded_amount,
            "milestone_count": self.milestone_count,
            "status": self.status,
        }

    @gl.public.view
    def get_milestone(self, milestone_index: u256) -> dict:
        if milestone_index not in self.milestones:
            raise gl.vm.UserError("No such milestone.")
        m = self.milestones[milestone_index]
        return {
            "name": m.name,
            "amount": m.amount,
            "criteria": m.criteria,
            "status": m.status,
            "released": m.released,
            "deliverable_text": m.deliverable_text,
            "deliverable_url": m.deliverable_url,
            "reasoning": m.reasoning,
        }
