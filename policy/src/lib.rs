//! Transaction-scope validity policy for the hosting market chain: filters on
//! keys and coin, nothing else. The policy never reads a record's value; what
//! an offer or order says is judged off chain (client/verdict.mjs).
//!
//! Keys (`<host>`, `<payer>` are account addresses, `<height>` and `<paid>`
//! canonical decimals, `<path>` one or more non-empty segments):
//!
//! - `offer/<host>/<id>/<height>`: the host signs; written once.
//! - `url/<host>`: the host signs.
//! - `order/<host>/<id>/<payer>/<height>/<paid>/<path>`: the payer signs;
//!   written once; the host is credited `<paid>` in the same transaction.
//!
//! An offer's or order's `<height>` is within the last 10 blocks. Every other
//! key is refused. Coin actions, deposits, receipts and withdrawals pass
//! untouched.
#![cfg_attr(not(test), no_std)]

use lattice_policy_rules::{decimal, is_address, transaction_body, Body, Signers};

lattice_policy_rules::lattice_policy_abi!(crate::validate);

/// How many blocks back a key's height may be.
pub const CREATED_WINDOW: u64 = 10;

/// Magic, encoding version, ABI version, scope, then the height.
const HEIGHT_AT: usize = 6 + 2 + 2 + 1;

/// The verdict for one policy context, with `scratch` for the signer table.
/// Anything malformed is a rejection.
pub fn validate(context: &[u8], scratch: &mut [u32]) -> bool {
    (|| {
        let height = u64::from_be_bytes(context.get(HEIGHT_AT..HEIGHT_AT + 8)?.try_into().ok()?);
        let body = Body::parse(transaction_body(context)?)?;
        let signers = body.signers(scratch)?;
        check_body(&body, &signers, height)
    })()
    .is_some()
}

fn check_body(body: &Body, signers: &Signers, height: u64) -> Option<()> {
    let mut payments = body.payments()?;
    for action in body.actions()? {
        let action = action?;
        let mut key = action.key.split(|&byte| byte == b'/');
        let once = action.old_value.is_none() && action.new_value.is_some();
        match key.next()? {
            b"offer" => {
                let host = address(key.next()?)?;
                segment(key.next()?)?;
                recent(key.next()?, height)?;
                (once && key.next().is_none()).then_some(())?;
                signers.is_signer(host)?;
            }
            b"url" => {
                signers.is_signer(address(key.next()?)?)?;
                key.next().is_none().then_some(())?;
            }
            b"order" => {
                let host = address(key.next()?)?;
                segment(key.next()?)?;
                let payer = address(key.next()?)?;
                recent(key.next()?, height)?;
                let paid = decimal(key.next()?).filter(|&paid| paid > 0)?;
                segment(key.next()?)?;
                key.try_for_each(|part| segment(part).map(|_| ()))?;
                once.then_some(())?;
                signers.is_signer(payer)?;
                payments.owe(host, paid)?;
            }
            _ => return None,
        }
    }
    payments.finish()
}

/// A canonical decimal height with `height - 10 <= it <= height`.
fn recent(text: &[u8], height: u64) -> Option<()> {
    let at = decimal(text)?;
    (at <= height && at >= height.saturating_sub(CREATED_WINDOW)).then_some(())
}

fn address(text: &[u8]) -> Option<&[u8]> {
    is_address(text).then_some(text)
}

fn segment(text: &[u8]) -> Option<&[u8]> {
    (!text.is_empty()).then_some(text)
}
