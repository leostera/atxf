//! Linearizing a transcript (SPEC §18.1): every branch on one path, so an agent continuing it sees what every branch
//! did, word for word. A port of `linearize.ts`, writing the same bytes.
//!
//! Tree records are written turn by turn. A turn starts at a root, at a user message, or at a branch, and runs down
//! its only child until the next one. Turns follow their parent turn, earliest first, except that a branch starting
//! mid-turn (another answer to the same prompt) comes right after the turn it branched from, and a record waits for
//! the records it references. Each record's parent becomes the record before it.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use crate::canonical::sha256;
use crate::integrity::{REFERENCE_FIELDS, add_integrity_owned};
use crate::json::{Get, Map, Value};
use crate::time;
use crate::transcript::{Error, Record, Transcript};

const DOMAIN: &str = "atxf/0.1/linearize\n";

#[derive(Clone, Debug, PartialEq)]
pub struct LinearizeResult {
    pub transcript: Transcript,
    /// How many branch tips the source had: 1 for a source that was already linear.
    pub branches: usize,
}

pub fn linearize(source: &Transcript) -> Result<LinearizeResult, Error> {
    let tree: Vec<&Map> = source.records.iter().filter(|r| r.is_tree()).collect();
    let position: HashMap<&str, usize> = tree.iter().enumerate().map(|(i, r)| (r.id(), i)).collect();
    let mut children: HashMap<Option<&str>, Vec<usize>> = HashMap::new();
    for (index, record) in tree.iter().enumerate() {
        // A parent the transcript does not hold (a dangling reference) makes the record a root (SPEC §4).
        let parent = record.parent_id().filter(|p| position.contains_key(p));
        children.entry(parent).or_default().push(index);
    }
    let branches = tree.iter().filter(|r| !children.contains_key(&Some(r.id()))).count();

    let ordered = order(&tree, &children, &position);
    let mut records: Vec<Map> = Vec::with_capacity(source.records.len());
    let mut previous: Option<&str> = None;
    for &index in &ordered {
        let mut record = stripped(tree[index]);
        record.insert("parentId".into(), previous.map_or(Value::Null, |p| Value::String(p.to_string())));
        previous = Some(tree[index].id());
        records.push(record);
    }
    // Where the leaf was and the seal over the source's records describe the source, not the linear transcript.
    for record in &source.records {
        if record.is_tree() || matches!(record.kind(), "leaf" | "seal") {
            continue;
        }
        records.push(stripped(record));
    }

    let ids: Vec<&str> = ordered.iter().map(|&i| tree[i].id()).collect();
    let transcript = Transcript { header: linear_header(&source.header, &ids), records };
    let transcript = if source.header.contains_key("integrity") { add_integrity_owned(transcript, None)? } else { transcript };
    Ok(LinearizeResult { transcript, branches })
}

fn stripped(record: &Map) -> Map {
    let mut out = record.clone();
    out.shift_remove("hash");
    out.shift_remove("native");
    out
}

/// A user message starts a turn; so does any record after a branch, which `order` checks itself.
fn starts_turn(record: &Map) -> bool {
    record.kind() == "message" && record.str("role") == Some("user")
}

/// As reconciling orders records: a time that does not parse comes first.
fn time_of(record: &Map) -> f64 {
    time::parse(record.time()).unwrap_or(f64::NEG_INFINITY)
}

/// The tree records' indexes in the order they are written. A record also waits for the records it references: its
/// turn is cut there, and the rest waits. This never deadlocks, since the source's file order puts every parent and
/// reference first, so the earliest record not yet written is always ready.
fn order(tree: &[&Map], children: &HashMap<Option<&str>, Vec<usize>>, position: &HashMap<&str, usize>) -> Vec<usize> {
    let mut written: HashSet<&str> = HashSet::new();
    let references_written = |record: &Map, written: &HashSet<&str>| {
        REFERENCE_FIELDS.iter().filter(|f| **f != "parentId").all(|field| match record.str(field) {
            Some(id) => !position.contains_key(id) || written.contains(id),
            None => true,
        })
    };
    let continues = |record: &Map| u8::from(!(record.parent_id().is_some_and(|p| position.contains_key(p)) && !starts_turn(record)));
    // Another answer to the same prompt (a branch mid-turn) first, then the earliest piece, then file order.
    let compare = |a: &usize, b: &usize| {
        let (ra, rb) = (tree[*a], tree[*b]);
        continues(ra)
            .cmp(&continues(rb))
            .then_with(|| time_of(ra).partial_cmp(&time_of(rb)).unwrap_or(Ordering::Equal))
            .then_with(|| a.cmp(b))
    };

    let mut pending: Vec<usize> = children.get(&None).cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(tree.len());
    while !pending.is_empty() {
        // A source whose references point forward (not valid) still linearizes: its earliest piece goes first.
        let head = pending
            .iter()
            .copied()
            .filter(|&i| references_written(tree[i], &written))
            .min_by(compare)
            .unwrap_or_else(|| *pending.iter().min().unwrap());
        pending.retain(|&i| i != head);
        let mut cursor = Some(head);
        while let Some(index) = cursor {
            out.push(index);
            written.insert(tree[index].id());
            cursor = None;
            let next = children.get(&Some(tree[index].id())).map(Vec::as_slice).unwrap_or_default();
            if let [only] = next
                && !starts_turn(tree[*only])
                && references_written(tree[*only], &written)
            {
                cursor = Some(*only);
            } else {
                pending.extend_from_slice(next);
            }
        }
    }
    out
}

/// The linear transcript's header: a new id, forked from the source, with no native session of its own yet. Fields
/// keep their place, and new ones go last, as in `linearize.ts`.
fn linear_header(source: &Map, ids: &[&str]) -> Map {
    let mut header = source.clone();
    header.shift_remove("hash");
    header.shift_remove("native");
    let source_id = source.str("id").unwrap_or_default();
    header.insert("id".into(), Value::String(uuid_from(&sha256(&format!("{DOMAIN}{source_id}\n{}", ids.join("\n"))))));
    let mut agent = source.obj("source").cloned().unwrap_or_default();
    agent.shift_remove("sessionId");
    header.insert("source".into(), Value::Object(agent));
    let mut parent = Map::new();
    parent.insert("transcriptId".into(), Value::String(source_id.to_string()));
    parent.insert("relation".into(), Value::String("fork".into()));
    header.insert("parent".into(), Value::Object(parent));
    let mut fidelity = source.obj("fidelity").cloned().unwrap_or_default();
    fidelity.shift_remove("nativeDigest");
    fidelity.shift_remove("native");
    fidelity.insert("topology".into(), Value::String("linearized".into()));
    header.insert("fidelity".into(), Value::Object(fidelity));
    header
}

/// A UUID (version 8, RFC 9562) made of the first bytes of a hex digest, so the id is deterministic.
fn uuid_from(hex: &str) -> String {
    let variant = (u8::from_str_radix(&hex[16..17], 16).unwrap_or(0) & 0x3) | 0x8;
    format!("{}-{}-8{}-{:x}{}-{}", &hex[0..8], &hex[8..12], &hex[13..16], variant, &hex[17..20], &hex[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::{index_tree, leaves};
    use crate::{parse_transcript, serialize_transcript, validate_transcript};

    #[test]
    fn every_example_linearizes_to_one_valid_path() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples");
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let source = parse_transcript(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let result = linearize(&source).unwrap();
            let text = serialize_transcript(&result.transcript);
            assert!(validate_transcript(&text).ok, "{}", path.display());
            let tree = result.transcript.records.iter().filter(|r| r.is_tree()).count();
            assert_eq!(tree, source.records.iter().filter(|r| r.is_tree()).count());
            if tree > 0 {
                assert_eq!(leaves(&index_tree(&result.transcript)).len(), 1, "{}", path.display());
            }
        }
    }
}
