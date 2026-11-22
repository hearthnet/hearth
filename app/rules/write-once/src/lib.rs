//! Rule preset "Append-only (write once)".
//!
//! Anyone may create any key, and nobody may change or delete it after.
//!
//! Coin actions pass untouched.
#![no_std]

use lattice_policy_rules::{transaction_body, Body};

lattice_policy_rules::lattice_policy_abi!(crate::validate);

/// The verdict for one policy context. Anything malformed is a rejection.
pub fn validate(context: &[u8], _scratch: &mut [u32]) -> bool {
    (|| {
        let body = Body::parse(transaction_body(context)?)?;
        for action in body.actions()? {
            let action = action?;
            (action.old_value.is_none() && action.new_value.is_some()).then_some(())?;
        }
        Some(())
    })()
    .is_some()
}
