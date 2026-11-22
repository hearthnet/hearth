//! Rule preset "Each person edits only their own keys".
//!
//! Every key ends with an account address, `<anything>/<address>` or just
//! `<address>`, and only a transaction from that account (its first signer)
//! may create, change or delete it. A fee sponsor co-signs after the writer,
//! so its signature reaches none of its own keys. Shared lists still read by
//! prefix: `events/42/<address>` is one person's event, and `events/` lists
//! everyone's.
//!
//! Coin actions pass untouched.
#![no_std]

use lattice_policy_rules::{is_address, transaction_body, Body};

lattice_policy_rules::lattice_policy_abi!(crate::validate);

/// The verdict for one policy context. Anything malformed is a rejection.
pub fn validate(context: &[u8], _scratch: &mut [u32]) -> bool {
    (|| {
        let bytes = transaction_body(context)?;
        let body = Body::parse(bytes)?;
        let writer = first_signer(bytes)?;
        for action in body.actions()? {
            let owner = action?.key.rsplit(|&byte| byte == b'/').next()?;
            (is_address(owner) && owner == writer).then_some(())?;
        }
        Some(())
    })()
    .is_some()
}

// The first entry of the body's `signers`, read here rather than in the rule
// library, so the library (and every module built on it) stays byte for byte
// the same. `Body::parse` has already checked the body is one well-formed map.

fn first_signer(body: &[u8]) -> Option<&[u8]> {
    let (major, pairs, mut at) = head(body, 0)?;
    (major == 5).then_some(())?;
    for _ in 0..pairs {
        let (name, value) = text(body, at)?;
        if name == b"signers" {
            let (major, count, first) = head(body, value)?;
            (major == 4 && count > 0).then_some(())?;
            return text(body, first).map(|(signer, _)| signer);
        }
        at = skip(body, value)?;
    }
    None
}

/// The item head at `at`: `(major type, argument, offset after the head)`.
fn head(bytes: &[u8], at: usize) -> Option<(u8, u64, usize)> {
    let first = *bytes.get(at)?;
    let width = match first & 0x1f {
        small @ 0..=23 => return Some((first >> 5, small as u64, at + 1)),
        24 => 1,
        25 => 2,
        26 => 4,
        27 => 8,
        _ => return None,
    };
    let end = (at + 1).checked_add(width)?;
    let argument = bytes.get(at + 1..end)?.iter().fold(0u64, |value, &byte| (value << 8) | byte as u64);
    Some((first >> 5, argument, end))
}

/// A text item at `at`, and the offset after it.
fn text(bytes: &[u8], at: usize) -> Option<(&[u8], usize)> {
    let (major, length, start) = head(bytes, at)?;
    let end = start.checked_add(usize::try_from(length).ok()?)?;
    (major == 3).then_some((bytes.get(start..end)?, end))
}

/// The offset just past the item at `at`.
fn skip(bytes: &[u8], mut at: usize) -> Option<usize> {
    let mut pending: u64 = 1;
    while pending > 0 {
        let (major, argument, next) = head(bytes, at)?;
        at = next;
        pending -= 1;
        match major {
            2 | 3 => at = at.checked_add(usize::try_from(argument).ok()?).filter(|&end| end <= bytes.len())?,
            4 => pending = pending.checked_add(argument)?,
            5 => pending = pending.checked_add(argument.checked_mul(2)?)?,
            6 => pending += 1,
            _ => {}
        }
    }
    Some(at)
}
