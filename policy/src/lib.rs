//! Transaction-scope validity policy for the hosting market chain: filters on
//! keys and coin, and reads one value, the offer an order asserts. What else
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
//!   and renewals apart. The asserted offer's value must parse (`offer`),
//!   `<path>`'s parent must be one of its `under` paths, and `<paid>` must be
//!   at least its `price`.
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
                let mut key = action.key.splitn(7, |&byte| byte == b'/');
                key.next()?;
                let host = address(key.next()?)?;
                let id = segment(key.next()?)?;
                let payer = address(key.next()?)?;
                decimal(key.next()?)?;
                let paid = decimal(key.next()?).filter(|&paid| paid > 0)?;
                let path = key.next()?;
                path.split(|&byte| byte == b'/').try_for_each(|part| segment(part).map(|_| ()))?;
                (action.old_value.is_none() && action.new_value.is_some()).then_some(())?;
                signers.is_signer(payer)?;
                check_order(path, paid, asserted_offer(body, host, id)?)?;
                payments.owe(host, paid)?;
            }
            _ => return None,
        }
    }
    payments.finish()
}

/// An order for `path` paying `paid` at the offer whose text is `offer`: the
/// offer parses, sells under `path`'s parent, and asks at most `paid`.
fn check_order(path: &[u8], paid: u64, offer: &[u8]) -> Option<()> {
    let parent = &path[..path.iter().rposition(|&byte| byte == b'/')?];
    (offer_price(offer, parent)? <= paid).then_some(())
}

/// An offer's price, when its text is exactly its lines and one of its
/// `under` paths is `parent`:
///
/// ```text
/// hashrate <n>
/// price <n>          at least 1
/// period <n>         at least 1
/// throughput <n>
/// storage <n>
/// blocks <address>
/// under <path>       one or more, sorted, no two the same
/// ```
///
/// each `<n>` a canonical decimal, lines split on `\n` with none after the last.
fn offer_price(offer: &[u8], parent: &[u8]) -> Option<u64> {
    let mut lines = offer.split(|&byte| byte == b'\n');
    let mut number = |name: &[u8]| decimal(field(lines.next()?, name)?);
    number(b"hashrate")?;
    let price = number(b"price").filter(|&price| price > 0)?;
    number(b"period").filter(|&period| period > 0)?;
    number(b"throughput")?;
    number(b"storage")?;
    is_address(field(lines.next()?, b"blocks")?).then_some(())?;
    let (mut previous, mut sells): (Option<&[u8]>, bool) = (None, false);
    for line in lines {
        let path = field(line, b"under")?;
        path.split(|&byte| byte == b'/').try_for_each(|part| segment(part).map(|_| ()))?;
        if previous.is_some_and(|previous| previous >= path) {
            return None;
        }
        sells |= path == parent;
        previous = Some(path);
    }
    previous?;
    sells.then_some(price)
}

/// The text after `<name> ` on a line.
fn field<'a>(line: &'a [u8], name: &[u8]) -> Option<&'a [u8]> {
    line.strip_prefix(name)?.strip_prefix(b" ")
}

/// An action that leaves its key exactly as it is.
fn is_assert(action: &Action) -> bool {
    matches!((action.old_value, action.new_value), (Some(old), Some(new)) if old == new)
}

/// The text of `offer/<host>/<id>`, when the body asserts it unchanged.
fn asserted_offer<'a>(body: &Body<'a>, host: &[u8], id: &[u8]) -> Option<&'a [u8]> {
    for action in body.actions()? {
        let action = action?;
        let mut key = action.key.split(|&byte| byte == b'/');
        if key.next() == Some(b"offer") && key.next() == Some(host) && key.next() == Some(id) && key.next().is_none() && is_assert(&action) {
            return action.new_value;
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

#[cfg(test)]
mod tests {
    use super::*;

    // Addresses in their canonical spelling: the eighth character a to h, the last a multiple of 4.
    fn key(n: u8) -> String {
        format!("bafyrei{}{}", (b'a' + n) as char, "a".repeat(51))
    }

    fn offer(under: &[&str]) -> String {
        let mut text = format!("hashrate 1000\nprice 50\nperiod 1440\nthroughput 2000\nstorage 3000\nblocks {}", key(1));
        for path in under {
            text.push_str("\nunder ");
            text.push_str(path);
        }
        text
    }

    // ---- DAG-CBOR, just enough for a transaction body ----

    fn head(out: &mut Vec<u8>, major: u8, n: u64) {
        let major = major << 5;
        match n {
            0..=23 => out.push(major | n as u8),
            24..=0xff => out.extend([major | 24, n as u8]),
            0x100..=0xffff => {
                out.push(major | 25);
                out.extend((n as u16).to_be_bytes());
            }
            0x1_0000..=0xffff_ffff => {
                out.push(major | 26);
                out.extend((n as u32).to_be_bytes());
            }
            _ => {
                out.push(major | 27);
                out.extend(n.to_be_bytes());
            }
        }
    }

    fn text(out: &mut Vec<u8>, s: &str) {
        head(out, 3, s.len() as u64);
        out.extend(s.as_bytes());
    }

    fn integer(out: &mut Vec<u8>, n: i64) {
        if n < 0 {
            head(out, 1, (-1 - n) as u64);
        } else {
            head(out, 0, n as u64);
        }
    }

    struct Write<'a> {
        key: &'a str,
        old: Option<&'a str>,
        new: Option<&'a str>,
    }

    fn assert_offer(host: &str, id: &str, terms: &str) -> (String, Option<String>, Option<String>) {
        (format!("offer/{host}/{id}"), Some(terms.into()), Some(terms.into()))
    }

    fn order(host: &str, payer: &str, paid: u64, path: &str, value: &str) -> (String, Option<String>, Option<String>) {
        (format!("order/{host}/o1/{payer}/0/{paid}/{path}"), None, Some(value.into()))
    }

    /// The context of a body writing `actions`, signed by `signer`, crediting `credits`.
    fn context(actions: &[(String, Option<String>, Option<String>)], signer: &str, credits: &[(&str, i64)]) -> Vec<u8> {
        let writes: Vec<Write> = actions.iter().map(|(key, old, new)| Write { key, old: old.as_deref(), new: new.as_deref() }).collect();
        let mut body = Vec::new();
        head(&mut body, 5, 3);
        text(&mut body, "signers");
        head(&mut body, 4, 1);
        text(&mut body, signer);
        text(&mut body, "actions");
        head(&mut body, 4, writes.len() as u64);
        for write in &writes {
            head(&mut body, 5, 1 + write.old.is_some() as u64 + write.new.is_some() as u64);
            text(&mut body, "key");
            text(&mut body, write.key);
            if let Some(old) = write.old {
                text(&mut body, "oldValue");
                text(&mut body, old);
            }
            if let Some(new) = write.new {
                text(&mut body, "newValue");
                text(&mut body, new);
            }
        }
        text(&mut body, "accountActions");
        let total: i64 = credits.iter().map(|(_, amount)| amount).sum();
        head(&mut body, 4, 1 + credits.len() as u64);
        for (owner, delta) in [(signer, -total)].iter().chain(credits) {
            head(&mut body, 5, 2);
            text(&mut body, "owner");
            text(&mut body, owner);
            text(&mut body, "delta");
            integer(&mut body, *delta);
        }
        let mut context = b"LWPCTX".to_vec();
        context.extend([0, 2, 0, 1, 1]);
        context.extend([0; 16]);
        context.extend(0u32.to_be_bytes());
        context.extend(0u32.to_be_bytes());
        context.push(1);
        context.extend((body.len() as u32).to_be_bytes());
        context.extend(body);
        context
    }

    fn accepts(actions: &[(String, Option<String>, Option<String>)], credits: &[(&str, i64)]) -> bool {
        validate(&context(actions, &key(2), credits), &mut [0; 64])
    }

    #[test]
    fn an_offer_parses_only_as_exactly_its_lines() {
        let good = offer(&["Nexus", "Nexus/testnet"]);
        assert_eq!(offer_price(good.as_bytes(), b"Nexus"), Some(50));
        assert_eq!(offer_price(good.as_bytes(), b"Nexus/testnet"), Some(50));
        let malformed = [
            String::new(),
            offer(&[]),
            good.clone() + "\n",
            good.replace("hashrate 1000\n", ""),
            good.replace("price 50", "price 0"),
            good.replace("price 50", "price 050"),
            good.replace("price 50", "price  50"),
            good.replace("price 50", "price -50"),
            good.replace("price 50", "price 18446744073709551616"),
            good.replace("period 1440", "period 0"),
            good.replace("throughput 2000", "throughput x"),
            good.replace("storage 3000", "storage"),
            good.replace(&key(1), "nobody"),
            good.replace("price 50\nperiod 1440", "period 1440\nprice 50"),
            good.replace("under", "Under"),
            good + "\nanything",
            offer(&["Nexus/testnet", "Nexus"]),
            offer(&["Nexus", "Nexus"]),
            offer(&["Nexus", "Nexus//a"]),
            offer(&["Nexus", "Nexus/"]),
            offer(&["", "Nexus"]),
        ];
        for text in &malformed {
            assert_eq!(offer_price(text.as_bytes(), b"Nexus"), None, "{text:?}");
        }
    }

    #[test]
    fn an_order_needs_its_parent_under_the_offer_and_at_least_its_price() {
        let terms = offer(&["Nexus", "Nexus/testnet"]);
        assert_eq!(check_order(b"Nexus/app", 50, terms.as_bytes()), Some(()), "exact pay");
        assert_eq!(check_order(b"Nexus/testnet/app", 70, terms.as_bytes()), Some(()), "overpaid");
        assert_eq!(check_order(b"Nexus/app", 49, terms.as_bytes()), None, "underpaid");
        assert_eq!(check_order(b"Nexus/other/app", 50, terms.as_bytes()), None, "a parent not sold under");
        assert_eq!(check_order(b"Nexus/testnet/a/app", 50, terms.as_bytes()), None, "deeper than a child of an under path");
        assert_eq!(check_order(b"Nexus", 50, terms.as_bytes()), None, "no parent");
        assert_eq!(check_order(b"Nexus/app", 50, b"price 1"), None, "an offer that does not parse");
    }

    #[test]
    fn a_transaction_with_an_order_is_refused_unless_its_asserted_offer_allows_it() {
        let (host, buyer) = (key(1), key(2));
        let terms = offer(&["Nexus/testnet"]);
        let launch = |paid, path: &str, value: &str| [assert_offer(&host, "o1", &terms), order(&host, &buyer, paid, path, value)];
        assert!(accepts(&launch(50, "Nexus/testnet/app", "{}"), &[(&host, 50)]), "exact pay");
        assert!(!accepts(&launch(49, "Nexus/testnet/app", "{}"), &[(&host, 49)]), "underpaid");
        assert!(!accepts(&launch(50, "Nexus/app", "{}"), &[(&host, 50)]), "another parent");
        assert!(!accepts(&launch(50, "Nexus/testnet/a/app", "{}"), &[(&host, 50)]), "deeper");
        let renew = "renew bafyreigenesis";
        assert!(accepts(&launch(100, "Nexus/testnet/app", renew), &[(&host, 100)]), "a renewal, as an order");
        assert!(!accepts(&launch(49, "Nexus/testnet/app", renew), &[(&host, 49)]), "an underpaid renewal");
        assert!(!accepts(&launch(50, "Nexus/other/app", renew), &[(&host, 50)]), "a renewal under another parent");
        let bad = terms.replace("period 1440", "period 0");
        assert!(!accepts(&[assert_offer(&host, "o1", &bad), order(&host, &buyer, 50, "Nexus/testnet/app", "{}")], &[(&host, 50)]), "malformed offer");
        let written = (format!("offer/{host}/o1"), None, Some(terms.clone()));
        assert!(!accepts(&[written, order(&host, &buyer, 50, "Nexus/testnet/app", "{}")], &[(&host, 50)]), "written, not asserted");
        assert!(!accepts(&[order(&host, &buyer, 50, "Nexus/testnet/app", "{}")], &[(&host, 50)]), "no offer asserted");
    }
}
