------------------------------ MODULE AiLedger ------------------------------
EXTENDS Integers, FiniteSets, TLC

CONSTANTS JobCount, RequestCount, Sends, SharedKey, Disruptions, Restart,
          Healthy, Fault, Controls

(* One process holds the app lock; two scoped workers can race for the single
   SQLite lane. Each database action below is one atomic transaction. An HTTP
   start is separate from validate_dispatch: authority is checked at the final
   dispatch DECISION, not retroactively after the provider has started work.
   Two approval generations and at most one process restart are explicit bounds.
   Countdown classes 0/1/2 encode expired, backoff, and larger server/pacing
   waits; Tick preserves their order/max. No state/depth constraint is used.
   Exact UTC, jitter, money rounding, source hashes and transport bytes are
   implementation-test obligations. Actual priced charge 2 exceeds reserve 1.
   Retry lane policy retains a positive interval after cooldown/reapproval/
   restart: Authorize starts another interval on an observed slow lane. At most
   two successful requests exist here, so production's three-success decay is
   outside this bound. These are ordering classes, not quota predictions.
   A one-retry configuration is a bounded subcase of the production max-two.
*)
Jobs == 1..JobCount
Requests == 1..RequestCount
Generations == 1..2
Workers == 1..2
Keys == IF SharedKey THEN {1} ELSE Jobs
Key(j) == IF SharedKey THEN 1 ELSE j
(* Explicit scenario factor: "all", "pause", or terminal stop controls.
   Companion configs retain two-job retries with terminal stops and restart. *)
ControlKinds == CASE Controls="all" -> {"paused","cancelled","source"}
                 [] Controls="pause" -> {"paused"}
                 [] Controls="stop" -> {"cancelled","source"}
WorkerJob(w) == IF JobCount = 1 THEN 1 ELSE w
Ids == Jobs \X Requests \X Generations \X (1..Sends)
Pairs == Jobs \X Requests
Empty == [stage |-> "unused", auth |-> FALSE, sent |-> FALSE,
          evidence |-> FALSE, hold |-> FALSE, charged |-> -1,
          settlements |-> 0]

VARIABLES job, generation, workerGeneration, attempts, completed, retry,
          backoff, server, pacing,slow, source, controlUsed, alive, restarted,
          priced, staleDecision, earlyRetry, completedResend, retryScopeError
vars == <<job, generation, workerGeneration, attempts, completed, retry,
          backoff, server, pacing,slow, source, controlUsed, alive, restarted,
          priced, staleDecision, earlyRetry, completedResend, retryScopeError>>
ActualCharge == IF priced THEN IF Healthy THEN 1 ELSE 2 ELSE -1

Active == {a \in Ids : attempts[a].stage = "reserved"}
Unknown == {a \in Ids : attempts[a].stage = "unknown"}
Used(j,r,g) == {a \in Ids : a[1]=j /\ a[2]=r /\ a[3]=g
                                     /\ attempts[a].stage # "unused"}
CanWait(j,r) == backoff[<<j,r>>]=0 /\ server[<<j,r>>]=0
               /\ pacing[Key(j)]=0
Current(w,j) == workerGeneration[w] = generation[j]
Runnable(j) == alive /\ job[j]="approved" /\ source[j]
NextRequest(j,r) == <<j,r>> \notin completed
                    /\ \A q \in 1..(r-1) : <<j,q>> \in completed

Init == /\ job = [j \in Jobs |-> "approved"]
        /\ generation = [j \in Jobs |-> 1]
        /\ workerGeneration = [w \in Workers |-> 1]
        /\ attempts = [a \in Ids |-> Empty]
        /\ completed = {}
        /\ retry = [p \in Pairs |-> FALSE]
        /\ backoff = [p \in Pairs |-> 0]
        /\ server = [p \in Pairs |-> 0]
        /\ pacing = [k \in Keys |-> 0]
        /\ slow = [k \in Keys |-> FALSE]
        /\ source = [j \in Jobs |-> TRUE]
        /\ controlUsed = [j \in Jobs |-> FALSE]
        /\ alive = TRUE /\ restarted = FALSE
        /\ priced \in BOOLEAN
        /\ staleDecision = FALSE /\ earlyRetry = FALSE
        /\ completedResend = FALSE /\ retryScopeError = FALSE

(* dispatch.rs reserve_next_inner: all guards + insertion in one transaction. *)
Reserve(w,j,r) ==
  LET n == Cardinality(Used(j,r,generation[j]))+1
      a == <<j,r,generation[j],n>>
  IN /\ WorkerJob(w)=j /\ Runnable(j)
     /\ (Current(w,j) \/ Fault="generation")
     /\ Active={} /\ Unknown={} /\ NextRequest(j,r)
     /\ n <= Sends /\ (n=1 \/ retry[<<j,r>>])
     /\ (CanWait(j,r) \/ Fault="floor")
     /\ attempts' = [attempts EXCEPT ![a]=
          [Empty EXCEPT !.stage="reserved", !.hold=TRUE]]
     /\ staleDecision' = (staleDecision \/ ~Current(w,j) \/ ~Runnable(j))
     /\ earlyRetry' = (earlyRetry \/ ~CanWait(j,r))
     /\ completedResend' = (completedResend \/ (<<j,r>> \in completed))
     /\ retryScopeError' = (retryScopeError \/ (n>1 /\ ~retry[<<j,r>>]))
     /\ UNCHANGED <<job,generation,workerGeneration,completed,retry,backoff,
          server,pacing,slow,source,controlUsed,alive,restarted,priced>>

(* dispatch.rs validate_dispatch; source/digest and budget validity are guards.
   source abstracts all frozen-input guards. Budgets are admitted capacity,
   never an invariant that a provider's final invoice is below a reservation. *)
Authorize(a) ==
  /\ a \in Active /\ ~attempts[a].auth /\ Runnable(a[1])
  /\ (a[3]=generation[a[1]] \/ Fault="generation")
  /\ CanWait(a[1],a[2])
  /\ attempts'=[attempts EXCEPT ![a].auth=TRUE]
  /\ pacing'=[pacing EXCEPT ![Key(a[1])]=IF slow[Key(a[1])] THEN 1 ELSE 0]
  /\ staleDecision'=(staleDecision \/ (a[3]#generation[a[1]])
                                    \/ ~Runnable(a[1]))
  /\ UNCHANGED <<job,generation,workerGeneration,completed,retry,backoff,server,
       slow,source,controlUsed,alive,restarted,priced,earlyRetry,
       completedResend,retryScopeError>>

(* vertex.rs transport.send: a cancellation can arrive after the atomic final
   authorization; it stops subsequent dispatch decisions, not authorized work. *)
Start(a) == /\ alive /\ a \in Active /\ attempts[a].auth
            /\ ~attempts[a].sent
            /\ attempts'=[attempts EXCEPT ![a].sent=TRUE]
            /\ UNCHANGED <<job,generation,workerGeneration,completed,retry,
                 backoff,server,pacing,slow,source,controlUsed,alive,restarted,priced,
                 staleDecision,earlyRetry,completedResend,retryScopeError>>

(* Evidence transaction precedes settlement; failures are a distinct outcome. *)
SaveEvidence(a) ==
  /\ alive /\ a \in Active /\ attempts[a].sent /\ ~attempts[a].evidence
  /\ attempts'=[attempts EXCEPT ![a].evidence=TRUE]
  /\ UNCHANGED <<job,generation,workerGeneration,completed,retry,backoff,server,
       pacing,slow,source,controlUsed,alive,restarted,priced,staleDecision,earlyRetry,
       completedResend,retryScopeError>>

(* settlement.rs finish_attempt: exactly once, valid durable usage/evidence.
   Delayed success after pause/cancel still settles; over-reservation needs review. *)
Settle(a) ==
  /\ alive /\ a \in Active /\ attempts[a].evidence
  /\ attempts'=[attempts EXCEPT ![a].stage="settled", ![a].hold=FALSE,
       ![a].charged=ActualCharge, ![a].settlements=@+1]
  /\ completed'=completed \cup {<<a[1],a[2]>>}
  /\ job'=[job EXCEPT ![a[1]]=IF @="approved" /\ ActualCharge>1
                                          THEN "review" ELSE @]
  /\ UNCHANGED <<generation,workerGeneration,retry,backoff,server,pacing,slow,source,
       controlUsed,alive,restarted,priced,staleDecision,earlyRetry,
       completedResend,retryScopeError>>

(* retries.rs handle_429: each 429 keeps its hold. Only the same approval may
   retry it; each new reservation consumes one reviewed send. Server long wait
   stops for review; backoff and shared pacing survive until countdown expiry. *)
Reject429(a,delay) ==
  /\ ~Healthy /\ alive /\ Sends>1 /\ a \in Active
  /\ attempts[a].sent /\ ~attempts[a].evidence
  /\ a[3]=generation[a[1]] /\ delay \in {1,2}
  /\ attempts'=[attempts EXCEPT ![a].stage="429"]
  /\ retry'=[retry EXCEPT ![<<a[1],a[2]>>]=
                      a[4]<Sends /\ delay=1 /\ job[a[1]]="approved"]
  /\ backoff'=[backoff EXCEPT ![<<a[1],a[2]>>]=1]
  /\ server'=[server EXCEPT ![<<a[1],a[2]>>]=delay]
  /\ pacing'=[pacing EXCEPT ![Key(a[1])]=2]
  /\ slow'=[slow EXCEPT ![Key(a[1])]=TRUE]
  /\ job'=[job EXCEPT ![a[1]]=IF a[4]=Sends \/ delay=2
                         THEN IF @="approved" THEN "review" ELSE @ ELSE @]
  /\ UNCHANGED <<generation,workerGeneration,completed,source,controlUsed,alive,
       restarted,priced,staleDecision,earlyRetry,completedResend,retryScopeError>>

(* Unknown transport, invalid usage, or evidence write failure: no refund or
   publication. Existing evidence remains inspectable. Terminal unknown records
   discard dead worker auth/sent phase bits; they cannot resume that worker.
   These phase bits are not durable dispatched_at metadata (a replay concern). *)
FailUnknown(a) ==
  /\ ~Healthy /\ alive /\ a \in Active /\ attempts[a].sent
  /\ attempts'=[attempts EXCEPT ![a].stage="unknown",
                                      ![a].auth=FALSE, ![a].sent=FALSE]
  /\ job'=[job EXCEPT ![a[1]]=IF @="approved" THEN "review" ELSE @]
  /\ UNCHANGED <<generation,workerGeneration,completed,retry,backoff,server,
       pacing,slow,source,controlUsed,alive,restarted,priced,staleDecision,earlyRetry,
       completedResend,retryScopeError>>

ReleaseUnsent(a) ==
  /\ ~Healthy /\ alive /\ a \in Active /\ ~attempts[a].sent
  /\ attempts'=[attempts EXCEPT ![a].stage="released", ![a].auth=FALSE,
       ![a].hold=FALSE,
                                           ![a].charged=0]
  /\ job'=[job EXCEPT ![a[1]]=IF @="approved" THEN "review" ELSE @]
  /\ UNCHANGED <<generation,workerGeneration,completed,retry,backoff,server,
       pacing,slow,source,controlUsed,alive,restarted,priced,staleDecision,earlyRetry,
       completedResend,retryScopeError>>

(* A failed atomic settlement write leaves the reservation and saved evidence
   unchanged. It may block forever in safety runs; healthy runs exclude it. *)
SettlementFailure(a) == /\ ~Healthy /\ alive /\ a \in Active
                         /\ attempts[a].evidence /\ UNCHANGED vars

(* acknowledge_unknown and every local reuse/reparse are accounting-neutral. *)
Acknowledge(a) ==
  /\ alive /\ a \in Unknown
  /\ attempts'=[attempts EXCEPT ![a].stage="accepted",
                                  ![a].hold=IF Fault="refund" THEN FALSE ELSE @]
  /\ UNCHANGED <<job,generation,workerGeneration,completed,retry,backoff,server,
       pacing,slow,source,controlUsed,alive,restarted,priced,staleDecision,earlyRetry,
       completedResend,retryScopeError>>
LocalReuse == /\ alive /\ UNCHANGED vars

(* approval.rs stop / source invalidation. One exogenous control event per job
   is the explicit scenario bound; pending authorized HTTP work may finish. *)
Control(j,kind) ==
  /\ Disruptions /\ ~Healthy /\ alive /\ ~controlUsed[j]
  /\ job[j]="approved" /\ kind \in ControlKinds
  /\ controlUsed'=[controlUsed EXCEPT ![j]=TRUE]
  /\ job'=[job EXCEPT ![j]=IF kind="source" THEN "review" ELSE kind]
  /\ source'=[source EXCEPT ![j]=IF kind="source" THEN FALSE ELSE @]
  /\ UNCHANGED <<generation,workerGeneration,attempts,completed,retry,backoff,
       server,pacing,slow,alive,restarted,priced,staleDecision,earlyRetry,
       completedResend,retryScopeError>>

(* approval.rs reapprove: cannot supersede a live reservation; acknowledgement
   retains money but unblocks review. Server floor crosses approval generations.
   Local retry backoff is approval-bound; persistent lane pacing is not. *)
Reapprove(j) ==
  /\ ~Healthy /\ alive /\ generation[j]=1 /\ source[j]
  /\ job[j] \in {"paused","review"}
  /\ ~\E a \in Active : a[1]=j
  /\ Unknown={} /\ \E r \in Requests : <<j,r>> \notin completed
  /\ \A r \in Requests : server[<<j,r>>]=0
  /\ generation'=[generation EXCEPT ![j]=2]
  /\ job'=[job EXCEPT ![j]="approved"]
  /\ retry'=[p \in Pairs |-> IF p[1]=j THEN FALSE ELSE retry[p]]
  /\ backoff'=[p \in Pairs |-> IF p[1]=j THEN 0 ELSE backoff[p]]
  /\ UNCHANGED <<workerGeneration,attempts,completed,server,pacing,slow,source,
       controlUsed,alive,restarted,priced,staleDecision,earlyRetry,
       completedResend,retryScopeError>>

RefreshWorker(w) ==
  /\ alive /\ workerGeneration[w]#generation[WorkerJob(w)]
  /\ workerGeneration'=[workerGeneration EXCEPT ![w]=generation[WorkerJob(w)]]
  /\ UNCHANGED <<job,generation,attempts,completed,retry,backoff,server,pacing,slow,
       source,controlUsed,alive,restarted,priced,staleDecision,earlyRetry,
       completedResend,retryScopeError>>

(* Process death destroys both workers. Reopen atomically converts ALL reserved
   attempts to unknown, even unsent ones, and revokes approved execution. *)
Crash ==
  /\ Restart /\ ~Healthy /\ alive /\ ~restarted
  /\ alive'=FALSE /\ restarted'=TRUE
  /\ workerGeneration'=[w \in Workers |-> 0]
  /\ UNCHANGED <<job,generation,attempts,completed,retry,backoff,server,pacing,slow,
       source,controlUsed,priced,staleDecision,earlyRetry,completedResend,
       retryScopeError>>
Reopen ==
  /\ ~alive /\ alive'=TRUE
  /\ attempts'=[a \in Ids |-> IF a \in Active
          THEN [attempts[a] EXCEPT !.stage="unknown", !.auth=FALSE, !.sent=FALSE]
          ELSE attempts[a]]
  /\ job'=[j \in Jobs |-> IF job[j]="approved" THEN "review" ELSE job[j]]
  /\ retry'=[p \in Pairs |-> FALSE]
  /\ UNCHANGED <<generation,workerGeneration,completed,backoff,server,pacing,slow,
       source,controlUsed,restarted,priced,staleDecision,earlyRetry,
       completedResend,retryScopeError>>

Dec(n) == IF n=0 THEN 0 ELSE n-1
Tick ==
  /\ ((\E p \in Pairs : backoff[p]>0 \/ server[p]>0)
       \/ (\E k \in Keys : pacing[k]>0))
  /\ backoff'=[p \in Pairs |-> Dec(backoff[p])]
  /\ server'=[p \in Pairs |-> Dec(server[p])]
  /\ pacing'=[k \in Keys |-> Dec(pacing[k])]
  /\ UNCHANGED <<job,generation,workerGeneration,attempts,completed,retry,slow,source,
       controlUsed,alive,restarted,priced,staleDecision,earlyRetry,
       completedResend,retryScopeError>>

ReserveAny == \E w \in Workers,j \in Jobs,r \in Requests : Reserve(w,j,r)
AuthorizeAny == \E a \in Ids : Authorize(a)
StartAny == \E a \in Ids : Start(a)
SaveAny == \E a \in Ids : SaveEvidence(a)
SettleAny == \E a \in Ids : Settle(a)
Next == \/ ReserveAny \/ AuthorizeAny \/ StartAny \/ SaveAny \/ SettleAny
        \/ (\E a \in Ids,d \in {1,2} : Reject429(a,d))
        \/ (\E a \in Ids : FailUnknown(a) \/ ReleaseUnsent(a) \/ Acknowledge(a)
                             \/ SettlementFailure(a))
        \/ (\E j \in Jobs,k \in ControlKinds: Control(j,k))
        \/ (\E j \in Jobs : Reapprove(j))
        \/ (\E w \in Workers : RefreshWorker(w))
        \/ Crash \/ Reopen \/ Tick \/ LocalReuse

Spec == Init /\ [][Next]_vars
HealthySpec == Spec /\ WF_vars(ReserveAny) /\ WF_vars(AuthorizeAny)
                   /\ WF_vars(StartAny) /\ WF_vars(SaveAny) /\ WF_vars(SettleAny)
                   /\ WF_vars(Tick)
(* Healthy progress uses only successful replies and in-reservation/unpriced jobs:
   no crash/pause/source/budget/unknown/excess-cost permanent block. *)
HealthyInit == Init
ProgressSpec == HealthyInit /\ [][Next]_vars
                   /\ WF_vars(ReserveAny) /\ WF_vars(AuthorizeAny)
                   /\ WF_vars(StartAny) /\ WF_vars(SaveAny) /\ WF_vars(SettleAny)
                   /\ WF_vars(Tick)
EventuallyComplete == <> (completed=Pairs)

TypeOK == /\ job \in [Jobs -> {"approved","paused","cancelled","review"}]
          /\ generation \in [Jobs -> Generations]
          /\ workerGeneration \in [Workers -> 0..2]
          /\ completed \subseteq Pairs /\ retry \in [Pairs -> BOOLEAN]
          /\ backoff \in [Pairs -> 0..2] /\ server \in [Pairs -> 0..2]
          /\ pacing \in [Keys -> 0..2] /\ slow \in [Keys -> BOOLEAN] /\ source \in [Jobs -> BOOLEAN]
          /\ controlUsed \in [Jobs -> BOOLEAN]
          /\ alive \in BOOLEAN /\ restarted \in BOOLEAN /\ priced \in BOOLEAN
          /\ attempts \in [Ids -> [stage : {"unused","reserved","429","unknown",
                     "accepted","settled","released"}, auth : BOOLEAN,
                     sent : BOOLEAN, evidence : BOOLEAN, hold : BOOLEAN,
                     charged : {-1,0,1,2}, settlements : 0..2]]
OneActiveReservation == Cardinality(Active)<=1
NoStaleAuthority == ~staleDecision
NoCompletedResend == ~completedResend
RetryFloorRespected == ~earlyRetry
RetryOnly429Scope == ~retryScopeError
UnknownHoldPreserved == \A a \in Ids :
             attempts[a].stage \in {"unknown","accepted","429"} => attempts[a].hold
SettlementOnce == \A a \in Ids : attempts[a].settlements<=1
EvidenceBeforeSettlement == \A a \in Ids :
             attempts[a].stage="settled" => attempts[a].evidence /\ attempts[a].sent
PerAttemptConservation == \A a \in Ids :
  /\ (attempts[a].stage \in {"reserved","unknown","accepted","429"}
      => attempts[a].hold /\ attempts[a].charged=-1 /\ attempts[a].settlements=0)
  /\ (attempts[a].stage="released" => ~attempts[a].hold /\ attempts[a].charged=0)
  /\ (attempts[a].stage="settled" => ~attempts[a].hold /\ attempts[a].settlements=1
                   /\ attempts[a].charged=ActualCharge)
NoRefundAfterSend == \A a \in Ids :
                         attempts[a].stage="released" => ~attempts[a].sent
=============================================================================
