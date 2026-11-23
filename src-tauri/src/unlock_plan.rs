//! The work of one unlock attempt by name (#357, PR 4a): carries out an [`UnlockPlan`] from the
//! registry. Nothing in the app calls it yet; the command that does is PR 4b.
//!
//! The rule it enforces: **a named attempt makes the same number of passphrase derivations whatever
//! the name matched** (0, 1 or up to [`crate::vault_registry::DUPLICATE_NAME_CAP`] vaults), with no
//! early exit when one opens, so neither the time nor the memory says how many vaults share a name or
//! whether the name is known. The derivations run one after another (never in parallel: a phone's
//! memory is one derivation's, not four), real vaults first in registry order, then decoys.
//!
//! - A real vault whose derivation could not be made at all (no vault in its folder yet, a header
//!   that cannot be read) reports [`RealOutcome::NotThere`] and is replaced by a decoy, so "this
//!   name exists but its vault was never made" looks like an unknown name.
//! - Decoys run at the dearest [`DeriveCost`] any real derivation in the attempt reported, and at
//!   least [`DeriveCost::DECOY`], never a cheaper one (today every header has exactly that cost, so
//!   this is a guard for the day a vault may differ). Limit, stated: a name that matched NO vault
//!   cannot know a dearer cost it was not told about, so a device holding vaults with different costs
//!   would show a difference between a name that matched a dearer vault and one that matched nothing.
//!   `valid_kdf_config` refuses such headers today (`valid_kdf_config_refuses_anything_but_the_decoy_cost`
//!   pins that, and so the assumption of one derivation per slot), and
//!   `decoy_cost_is_what_vaults_are_written_with` fails the build if a new header's cost drifts from
//!   the decoy's.
//! - If two vaults with the name share the passphrase, the first in registry order opens.
//! - **What this module does NOT yet equalise: disk reads.** A decoy reads nothing, while a real
//!   vault's derivation first reads its header files and tries each copy, so the attempt's I/O (and
//!   its atime and inotify trace) still grows with the number of matches. Counting derivations is
//!   necessary, not sufficient. PR 4b closes this by reading the headers of EVERY registry slot (or
//!   a fixed number) before any derivation, whatever the name matched, and handing the pre-read
//!   header to the real derivation; until then the claim above is about derivations only.
#![cfg_attr(not(test), allow(dead_code))]

use crate::vault::DeriveCost;
use crate::vault_registry::{SlotId, UnlockPlan};

/// What a real vault's derivation did.
pub(crate) enum RealOutcome<T> {
    /// One derivation was made, at `cost`; `opened` is what it opened, if the passphrase was right.
    Derived { cost: DeriveCost, opened: Option<T> },
    /// No derivation could be made for this slot: a decoy takes its place.
    NotThere,
}

/// What an attempt did.
pub(crate) struct PlanRun<T> {
    /// The first vault in registry order whose passphrase was right, with what it opened.
    pub(crate) winner: Option<(SlotId, T)>,
    /// Derivations made (real and decoy). Equal to `plan.derivations()` every time.
    pub(crate) derivations: usize,
}

/// Runs every derivation of `plan`: `real` once per matched slot in order, then `decoy` for each
/// missing real derivation and each planned decoy, with the cost to derive at. No early exit.
pub(crate) fn run_plan<T>(
    plan: &UnlockPlan,
    mut real: impl FnMut(SlotId) -> RealOutcome<T>,
    mut decoy: impl FnMut(DeriveCost),
) -> PlanRun<T> {
    let mut winner = None;
    let mut cost = DeriveCost::DECOY;
    let mut derivations = 0;
    let mut missing = 0;
    for &slot in &plan.real {
        match real(slot) {
            RealOutcome::Derived { cost: used, opened } => {
                derivations += 1;
                cost = cost.dearer(used);
                if winner.is_none() {
                    winner = opened.map(|opened| (slot, opened));
                }
            }
            RealOutcome::NotThere => missing += 1,
        }
    }
    for _ in 0..(missing + plan.decoys) {
        decoy(cost);
        derivations += 1;
    }
    debug_assert_eq!(derivations, plan.derivations());
    PlanRun {
        winner,
        derivations,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_registry::{HashCost, Registry, DUPLICATE_NAME_CAP, NAME_HASHES};
    use std::cell::{Cell, RefCell};

    /// A registry with `same` vaults named "Sam", one named "Other", and Main (no name).
    fn registry_with(same: usize) -> (Registry, Vec<SlotId>) {
        let mut registry = Registry::with_main(HashCost::TEST).unwrap();
        let slots = (0..same)
            .map(|_| registry.add_extra("Sam").unwrap())
            .collect();
        registry.add_extra("Other").unwrap();
        (registry, slots)
    }

    /// Runs the plan for `typed` with counting stand-ins for the derivations.
    fn count(registry: &Registry, typed: &str) -> (usize, usize, usize, Vec<&'static str>) {
        let order = RefCell::new(Vec::new());
        let (reals, decoys) = (Cell::new(0), Cell::new(0));
        NAME_HASHES.with(|n| n.set(0));
        let plan = registry.plan_for(typed);
        let run = run_plan(
            &plan,
            |_slot| {
                reals.set(reals.get() + 1);
                order.borrow_mut().push("real");
                RealOutcome::<()>::Derived {
                    cost: DeriveCost::DECOY,
                    opened: None,
                }
            },
            |_cost| {
                decoys.set(decoys.get() + 1);
                order.borrow_mut().push("decoy");
            },
        );
        assert_eq!(run.derivations, reals.get() + decoys.get());
        (
            reals.get(),
            decoys.get(),
            NAME_HASHES.with(Cell::get),
            order.into_inner(),
        )
    }

    #[test]
    fn a_named_attempt_makes_the_same_number_of_derivations_for_0_1_2_3_and_4_matches() {
        // 0 matches: a name nothing has. 1 to 4: that many vaults called "Sam".
        let (none, _) = registry_with(0);
        let (reals, decoys, hashes, order) = count(&none, "Nobody");
        assert_eq!((reals, decoys, hashes), (0, DUPLICATE_NAME_CAP, 1));
        assert!(order.iter().all(|kind| *kind == "decoy"));
        for sharing in 1..=DUPLICATE_NAME_CAP {
            let (registry, _) = registry_with(sharing);
            let (reals, decoys, hashes, order) = count(&registry, "  SAM ");
            assert_eq!(reals, sharing, "{sharing} sharing");
            assert_eq!(reals + decoys, DUPLICATE_NAME_CAP, "{sharing} sharing");
            // One name hash whatever matched.
            assert_eq!(hashes, 1, "{sharing} sharing");
            // Real derivations first, in registry order, then the decoys.
            let mut sorted = order.clone();
            sorted.sort_by_key(|kind| *kind == "decoy");
            assert_eq!(order, sorted, "{sharing} sharing");
        }
    }

    #[test]
    fn an_empty_name_is_the_default_vault_alone_with_one_derivation_and_no_name_hash() {
        let (registry, _) = registry_with(2);
        for typed in ["", "   ", "\u{200B}"] {
            let (reals, decoys, hashes, _) = count(&registry, typed);
            assert_eq!((reals, decoys, hashes), (1, 0, 0), "{typed:?}");
        }
        // A registry with no default still makes the one derivation, against a decoy.
        let empty = Registry::new(HashCost::TEST).unwrap();
        let (reals, decoys, hashes, _) = count(&empty, "");
        assert_eq!((reals, decoys, hashes), (0, 1, 0));
    }

    #[test]
    fn a_slot_with_no_vault_to_derive_against_is_replaced_by_a_decoy() {
        let (registry, _) = registry_with(2);
        let decoys = Cell::new(0);
        let plan = registry.plan_for("sam");
        let run = run_plan(
            &plan,
            |_| RealOutcome::<()>::NotThere,
            |_| decoys.set(decoys.get() + 1),
        );
        assert_eq!(decoys.get(), DUPLICATE_NAME_CAP);
        assert_eq!(run.derivations, DUPLICATE_NAME_CAP);
        assert!(run.winner.is_none());
    }

    #[test]
    fn no_early_exit_when_a_vault_opens_and_the_first_in_registry_order_wins() {
        let (registry, slots) = registry_with(3);
        let calls = Cell::new(0);
        let plan = registry.plan_for("Sam");
        // Every one of the three would open; the first listed wins and the others still derive.
        let run = run_plan(
            &plan,
            |slot| {
                calls.set(calls.get() + 1);
                RealOutcome::Derived {
                    cost: DeriveCost::DECOY,
                    opened: Some(slot),
                }
            },
            |_| calls.set(calls.get() + 1),
        );
        assert_eq!(calls.get(), DUPLICATE_NAME_CAP);
        assert_eq!(run.winner.map(|(slot, _)| slot), Some(slots[0]));
    }

    #[test]
    fn a_wrong_passphrase_and_a_right_one_make_the_same_derivations() {
        let (registry, slots) = registry_with(1);
        let plan = registry.plan_for("sam");
        for right in [false, true] {
            let calls = Cell::new(0);
            let run = run_plan(
                &plan,
                |slot| {
                    calls.set(calls.get() + 1);
                    RealOutcome::Derived {
                        cost: DeriveCost::DECOY,
                        opened: right.then_some(slot),
                    }
                },
                |_| calls.set(calls.get() + 1),
            );
            assert_eq!(calls.get(), DUPLICATE_NAME_CAP);
            assert_eq!(run.winner.is_some(), right);
            assert_eq!(run.winner.map(|(slot, _)| slot), right.then_some(slots[0]));
        }
    }

    #[test]
    fn decoys_run_at_the_dearest_cost_a_real_derivation_reported_and_never_less_than_the_default() {
        let dearer = DeriveCost::DECOY.dearer(crate::vault::test_costs::dearer());
        assert_ne!(dearer, DeriveCost::DECOY);
        let (registry, _) = registry_with(2);
        let plan = registry.plan_for("sam");
        let seen = RefCell::new(Vec::new());
        run_plan(
            &plan,
            |slot| RealOutcome::<()>::Derived {
                // The second vault is dearer than the first.
                cost: if Some(&slot) == plan.real.get(1) {
                    dearer
                } else {
                    DeriveCost::DECOY
                },
                opened: None,
            },
            |cost| seen.borrow_mut().push(cost),
        );
        assert_eq!(seen.into_inner(), vec![dearer; DUPLICATE_NAME_CAP - 2]);
        // With nothing dearer reported, decoys cost exactly the default.
        let seen = RefCell::new(Vec::new());
        run_plan(
            &registry_with(0).0.plan_for("nobody"),
            |_| RealOutcome::<()>::NotThere,
            |cost| seen.borrow_mut().push(cost),
        );
        assert_eq!(
            seen.into_inner(),
            vec![DeriveCost::DECOY; DUPLICATE_NAME_CAP]
        );
    }

    /// The tripwire: the decoy cost is what vaults are written with. The day a header may carry
    /// other settings, this fails, and the rule in the module note has to be revisited.
    #[test]
    fn decoy_cost_is_what_vaults_are_written_with() {
        assert_eq!(
            DeriveCost::DECOY,
            crate::vault::test_costs::written_with(),
            "a new vault's header and the decoy cost have drifted apart"
        );
    }

    #[test]
    fn a_decoy_derivation_runs_and_opens_nothing() {
        // A cheap cost, to keep the test short: the point is that it derives and returns.
        assert!(crate::vault::test_costs::derive_cheap_decoy().is_ok());
    }
}
