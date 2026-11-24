//! Transaction-scope validity policy for the hosting market chain: filters on
//! keys and coin, nothing else. The policy never reads a record's value; what
//! an offer or order says is judged off chain (client/verdict.mjs).
//!
//! Keys (`<host>`, `<payer>` are account addresses, `<n>` and `<paid>`
//! canonical decimals, `<path>` one or more non-empty segments):
//!
//! - `offer/<host>/<id>`: the host writes, changes and deletes it. Anyone
//!   may assert it unchanged (old value = new value), which Lattice refuses
//!   unless the offer still holds exactly those bytes.
//! - `order/<host>/<id>/<payer>/<n>/<paid>/<path>`: the payer signs; written
//!   once; the host is credited `<paid>` in the same transaction, which also
//!   asserts `offer/<host>/<id>` unchanged. `<n>` tells one payer's orders
//!   and renewals apart.
//!
//! Every other key is refused. Coin actions, deposits, receipts and
//! withdrawals pass untouched.
#![cfg_attr(not(test), no_std)]

use lattice_policy_rules::{decimal, is_address, transaction_body, Action, Body, Signers};

lattice_policy_rules::lattice_policy_abi!(crate::validate);

/// The verdict for one policy context, with `scratch` for the signer table.
/// Anything malformed is a rejection.
pub fn validate(context: &[u8], scratch: &mut [u32]) -> bool {
    (|| {
        let body = Body::parse(transaction_body(context)?)?;
        let signers = body.signers(scratch)?;
        check_body(&body, &signers)
    })()
    .is_some()
}

fn check_body(body: &Body, signers: &Signers) -> Option<()> {
    let mut payments = body.payments()?;
    for action in body.actions()? {
        let action = action?;
        let mut key = action.key.split(|&byte| byte == b'/');
        match key.next()? {
            b"offer" => {
                let host = address(key.next()?)?;
                segment(key.next()?)?;
                key.next().is_none().then_some(())?;
                if !is_assert(&action) {
                    signers.is_signer(host)?;
                }
            }
            b"order" => {
                let host = address(key.next()?)?;
                let id = segment(key.next()?)?;
                let payer = address(key.next()?)?;
                decimal(key.next()?)?;
                let paid = decimal(key.next()?).filter(|&paid| paid > 0)?;
                segment(key.next()?)?;
                key.try_for_each(|part| segment(part).map(|_| ()))?;
                (action.old_value.is_none() && action.new_value.is_some()).then_some(())?;
                signers.is_signer(payer)?;
                asserts_offer(body, host, id)?;
                payments.owe(host, paid)?;
            }
            _ => return None,
        }
    }
    payments.finish()
}

/// An action that leaves its key exactly as it is.
fn is_assert(action: &Action) -> bool {
    matches!((action.old_value, action.new_value), (Some(old), Some(new)) if old == new)
}

/// Whether the body asserts `offer/<host>/<id>` unchanged.
fn asserts_offer(body: &Body, host: &[u8], id: &[u8]) -> Option<()> {
    for action in body.actions()? {
        let action = action?;
        let mut key = action.key.split(|&byte| byte == b'/');
        if key.next() == Some(b"offer") && key.next() == Some(host) && key.next() == Some(id) && key.next().is_none() && is_assert(&action) {
            return Some(());
        }
    }
    None
}

fn address(text: &[u8]) -> Option<&[u8]> {
    is_address(text).then_some(text)
}

fn segment(text: &[u8]) -> Option<&[u8]> {
    (!text.is_empty()).then_some(text)
}
