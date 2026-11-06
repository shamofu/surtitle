--------------------------- MODULE ProviderLedger ---------------------------
EXTENDS Integers, FiniteSets, TLC
CONSTANT Fault

(* Provider boundary refinement of AiLedger: four frozen jobs (three Vertex,
   one OpenAI), one attempt each, two profiles, and a shared outbound lane.
   ActiveProfile abstracts arbitrary settings changes after approval. Capacity
   is 3, reservation is 1, and actual cost is 2: a provider invoice may exceed
   its estimate. Money is retained by unknown acknowledgement and calendar
   rollover. Exact prices, migration bytes and UTC are Rust-test obligations.
   No depth/state constraints are used. *)
Providers == {"vertex", "openai"}
Jobs == 1..4
Provider(j) == IF j=4 THEN "openai" ELSE "vertex"
VARIABLES stage, activeProfile, held, charged, cooldown, badAdmission
vars == <<stage, activeProfile, held, charged, cooldown, badAdmission>>
Active == {j \in Jobs : stage[j]="reserved"}
Unknown(p) == {j \in Jobs : stage[j]="unknown" /\ Provider(j)=p}
Used(p) == held[p]+charged[p]
Init == /\ stage=[j \in Jobs |-> "approved"]
        /\ activeProfile="vertex"
        /\ held=[p \in Providers |-> 0]
        /\ charged=[p \in Providers |-> 0]
        /\ cooldown=[p \in Providers |-> 0]
        /\ badAdmission=FALSE

Reserve(j) ==
  LET p == Provider(j)
      budgetProfile == IF Fault="budget" THEN activeProfile ELSE p
  IN /\ stage[j]="approved"
     /\ (Active={} \/ (Fault="lane" /\ \A a \in Active : Provider(a)#p))
     /\ (Unknown(p)={} \/ Fault="unknown")
     /\ cooldown[p]=0 /\ Used(budgetProfile)+1<=3
     /\ stage'=[stage EXCEPT ![j]="reserved"]
     /\ held'=[held EXCEPT ![p]=@+1]
     /\ badAdmission'=(badAdmission \/ Used(p)+1>3)
     /\ UNCHANGED <<activeProfile,charged,cooldown>>
Settle(j) ==
  LET p == IF Fault="accounting" THEN activeProfile ELSE Provider(j)
  IN /\ j \in Active
     /\ stage'=[stage EXCEPT ![j]="settled"]
     /\ held'=[held EXCEPT ![p]=@-1]
     /\ charged'=[charged EXCEPT ![p]=@+2]
     /\ UNCHANGED <<activeProfile,cooldown,badAdmission>>
Fail(j) == /\ j \in Active
           /\ stage'=[stage EXCEPT ![j]="unknown"]
           /\ UNCHANGED <<activeProfile,held,charged,cooldown,badAdmission>>
Reject429(j) == /\ j \in Active
                /\ stage'=[stage EXCEPT ![j]="accepted"]
                /\ cooldown'=[cooldown EXCEPT ![Provider(j)]=1]
                /\ UNCHANGED <<activeProfile,held,charged,badAdmission>>
Acknowledge(j) == /\ stage[j]="unknown"
                  /\ stage'=[stage EXCEPT ![j]="accepted"]
                  /\ UNCHANGED <<activeProfile,held,charged,cooldown,badAdmission>>
Release(j) == /\ j \in Active
              /\ stage'=[stage EXCEPT ![j]="released"]
              /\ held'=[held EXCEPT ![Provider(j)]=@-1]
              /\ UNCHANGED <<activeProfile,charged,cooldown,badAdmission>>
Switch(p) == /\ p \in Providers /\ activeProfile'=p
             /\ UNCHANGED <<stage,held,charged,cooldown,badAdmission>>
Tick == /\ cooldown'=[p \in Providers |-> 0]
        /\ UNCHANGED <<stage,activeProfile,held,charged,badAdmission>>
CalendarRollover == UNCHANGED vars
Next == \/ (\E j \in Jobs : Reserve(j) \/ Settle(j) \/ Fail(j)
                    \/ Reject429(j) \/ Acknowledge(j) \/ Release(j))
        \/ (\E p \in Providers : Switch(p)) \/ Tick \/ CalendarRollover
Spec == Init /\ [][Next]_vars

TypeOK == /\ stage \in [Jobs -> {"approved","reserved","unknown","accepted","settled","released"}]
          /\ activeProfile \in Providers
          /\ held \in [Providers -> -3..3] /\ charged \in [Providers -> 0..6]
          /\ cooldown \in [Providers -> 0..1] /\ badAdmission \in BOOLEAN
OneOutbound == Cardinality(Active)<=1
ProviderAccounting == \A p \in Providers :
  /\ held[p]=Cardinality({j \in Jobs : Provider(j)=p /\ stage[j] \in {"reserved","unknown","accepted"}})
  /\ charged[p]=2*Cardinality({j \in Jobs : Provider(j)=p /\ stage[j]="settled"})
ProviderUnknownGuard == \A j \in Active : Unknown(Provider(j))={}
ProviderBudgetAdmission == ~badAdmission
=============================================================================
