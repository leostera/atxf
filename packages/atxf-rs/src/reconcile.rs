//! Reconciling copies of one session (SPEC §18; `specs/reconcile.ts`).
//!
//! Copies of a session diverge when it is continued in two places. Reconciling them is a union of their records,
//! keyed by a Merkle hash of each record: its content and the keys of the records it references, as in SPEC §17 but
//! without ids. Two records are the same record exactly when their keys are equal, so the union keeps every record
//! of every copy once, and divergent suffixes become sibling branches. The result does not depend on the order of
//! the copies or on how they are grouped, and reconciling a result again changes nothing.
//!
//! Ids only name records. Of the records sharing an id, the one with the smallest key keeps it and the others are
//! renamed `id~<hash prefix>`, with every reference to them rewritten. Records are written referenced-first, then
//! by time, then by key; the active leaf follows from that order.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};

use crate::canonical::{canonical_json, sha256};
use crate::integrity::{Hash, IntegrityProblem, REFERENCE_FIELDS, SealAt, add_integrity, verify_integrity, without_hash};
use crate::json::{Get, Map, Obj, Value, cmp_utf16};
use crate::time;
use crate::transcript::{Error, Record, Transcript};

const DOMAIN: &str = "atxf/0.1/reconcile\n";

/// A record that shares an id with a different record, and the id it has in the result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Renamed {
    pub id: String,
    pub as_id: String,
    pub key: Hash,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReconcileResult {
    pub transcript: Transcript,
    pub renamed: Vec<Renamed>,
    /// Hashes that did not verify, by copy index. The records are reconciled by content regardless.
    pub problems: Vec<(usize, Vec<IntegrityProblem>)>,
}

#[derive(Clone, Debug)]
struct Keyed {
    key: Hash,
    record: Map,
    /// Reference field → the referenced record's key; `native.of` is under `of`.
    refs: Vec<(String, Option<Hash>)>,
    time: f64,
}

/// The reconciliation key of every record of a copy, except seals: a digest of the record's content without its
/// id, its hash or the ids it references, and of the keys of the records it references.
fn key_copy(copy: &Transcript) -> Result<Vec<Keyed>, Error> {
    let mut key_of: HashMap<String, Hash> = HashMap::new();
    let mut out = Vec::new();
    for (index, record) in copy.records.iter().enumerate() {
        if key_of.contains_key(record.id()) {
            return Err(Error::new(format!("a copy of `{}` has two records with id `{}`", copy.id(), record.id())));
        }
        if record.kind() == "seal" {
            continue;
        }
        let unhashed = without_hash(record);
        let mut content = unhashed.clone();
        content.insert("id".into(), Value::String(String::new()));
        let mut refs: Vec<(String, Option<Hash>)> = Vec::new();
        let resolve = |field: &str, id: &str| {
            key_of
                .get(id)
                .cloned()
                .ok_or_else(|| Error::new(format!("a copy of `{}`, record {}: {field} `{id}` has no earlier record", copy.id(), index + 1)))
        };
        for field in REFERENCE_FIELDS {
            match unhashed.field(field) {
                Some(Value::Null) => refs.push((field.to_string(), None)),
                Some(Value::String(id)) => {
                    refs.push((field.to_string(), Some(resolve(field, id)?)));
                    content.insert(field.to_string(), Value::String(String::new()));
                }
                _ => {}
            }
        }
        if let Some(native) = unhashed.obj("native")
            && let Some(of) = native.field("of")
        {
            let of = of
                .as_str()
                .ok_or_else(|| Error::new(format!("a copy of `{}`, record {}: native.of is not an id", copy.id(), index + 1)))?;
            refs.push(("of".to_string(), Some(resolve("native.of", of)?)));
            content.insert("native".into(), Obj::new().spread(native).set("of", "").value());
        }
        let mut ref_map = Map::new();
        for (field, key) in &refs {
            ref_map.insert(field.clone(), key.clone().map_or(Value::Null, Value::String));
        }
        let key = format!(
            "sha256:{}",
            sha256(&format!(
                "{DOMAIN}{}",
                canonical_json(&Obj::new().set("content", Value::Object(content)).set("refs", Value::Object(ref_map)).value())
            ))
        );
        key_of.insert(record.id().to_string(), key.clone());
        out.push(Keyed { key, record: unhashed, refs, time: time::parse(record.time()).unwrap_or(f64::NEG_INFINITY) });
    }
    Ok(out)
}

/// The reconciliation keys of a transcript's records. Two copies are in sync when their sets of keys are equal.
pub fn reconciliation_keys(transcript: &Transcript) -> Result<HashSet<Hash>, Error> {
    Ok(key_copy(transcript)?.into_iter().map(|k| k.key).collect())
}

/// Whether two copies hold the same records, whatever their ids, order, hashes or seals.
pub fn in_sync(a: &Transcript, b: &Transcript) -> Result<bool, Error> {
    Ok(reconciliation_keys(a)? == reconciliation_keys(b)?)
}

/// Reconcile copies of one session into one transcript that keeps every record of every copy. The result is hashed
/// and sealed when `integrity` says so, or by default when any copy declares integrity.
pub fn reconcile(copies: &[Transcript], integrity: Option<bool>) -> Result<ReconcileResult, Error> {
    let first = copies.first().ok_or_else(|| Error::new("reconcile needs at least one copy"))?;
    for copy in copies {
        if copy.id() != first.id() {
            return Err(Error::new(format!("copies of different sessions: `{}` and `{}`", first.id(), copy.id())));
        }
    }
    let problems = copies
        .iter()
        .enumerate()
        .filter(|(_, c)| c.header.has("integrity"))
        .map(|(i, c)| (i, verify_integrity(c)))
        .filter(|(_, p)| !p.is_empty())
        .collect();

    let mut by_key: HashMap<Hash, Keyed> = HashMap::new();
    for copy in copies {
        for keyed in key_copy(copy)? {
            // The same record may have different ids in different copies: an earlier reconciliation renamed it, or
            // the ids are positions. Keep the smallest, so the choice does not depend on the order of the copies.
            match by_key.get(&keyed.key) {
                Some(kept) if cmp_utf16(keyed.record.id(), kept.record.id()) != Ordering::Less => {}
                _ => {
                    by_key.insert(keyed.key.clone(), keyed);
                }
            }
        }
    }

    let ordered = topological_order(by_key.into_values().collect());
    let (ids, renamed) = assign_ids(&ordered);
    let records = ordered.iter().map(|k| rewrite(k, &ids)).collect();
    let transcript = Transcript { header: pick_header(copies), records };
    let integrity = integrity.unwrap_or_else(|| copies.iter().any(|c| c.header.has("integrity")));
    if !integrity {
        return Ok(ReconcileResult { transcript, renamed, problems });
    }
    let mut keys: Vec<&str> = ordered.iter().map(|k| k.key.as_str()).collect();
    keys.sort_by(|a, b| cmp_utf16(a, b));
    let last = ordered.last().map_or_else(|| transcript.header.str("time").unwrap_or("").to_string(), |k| k.record.time().to_string());
    let seal_id = format!("seal~{}", &sha256(&keys.join("\n"))[..12]);
    let sealed = add_integrity(&transcript, Some(SealAt { id: &seal_id, time: &last }))?;
    Ok(ReconcileResult { transcript: sealed, renamed, problems })
}

/// Orders the heap so the earliest, then smallest key, pops first.
struct Ready(Keyed);

impl PartialEq for Ready {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Ready {}
impl PartialOrd for Ready {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Ready {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reversed: BinaryHeap is a max-heap.
        other.0.time.total_cmp(&self.0.time).then_with(|| cmp_utf16(&other.0.key, &self.0.key))
    }
}

/// References first; among the records whose references are all written, the earliest, then the smallest key.
fn topological_order(records: Vec<Keyed>) -> Vec<Keyed> {
    let mut waiting: HashMap<Hash, usize> = HashMap::new();
    let mut dependents: HashMap<Hash, Vec<Hash>> = HashMap::new();
    for keyed in &records {
        let deps: HashSet<&Hash> = keyed.refs.iter().filter_map(|(_, r)| r.as_ref()).collect();
        waiting.insert(keyed.key.clone(), deps.len());
        for dep in deps {
            dependents.entry(dep.clone()).or_default().push(keyed.key.clone());
        }
    }
    let mut pending: HashMap<Hash, Keyed> = HashMap::new();
    let mut ready = BinaryHeap::new();
    for keyed in records {
        if waiting[&keyed.key] == 0 {
            ready.push(Ready(keyed));
        } else {
            pending.insert(keyed.key.clone(), keyed);
        }
    }
    let mut out = Vec::new();
    while let Some(Ready(next)) = ready.pop() {
        for dependent in dependents.get(&next.key).into_iter().flatten() {
            let left = waiting.get_mut(dependent).expect("every dependent is a record");
            *left -= 1;
            if *left == 0
                && let Some(keyed) = pending.remove(dependent)
            {
                ready.push(Ready(keyed));
            }
        }
        out.push(next);
    }
    // Every reference resolves within its own copy, so there is no cycle and nothing is left waiting.
    out
}

/// The smallest key keeps a shared id; the others get `id~<key prefix>`, long enough to be unique.
fn assign_ids(records: &[Keyed]) -> (HashMap<Hash, String>, Vec<Renamed>) {
    let mut by_id: Vec<(String, Vec<Hash>)> = Vec::new();
    let mut index: HashMap<&str, usize> = HashMap::new();
    for keyed in records {
        let id = keyed.record.id();
        match index.get(id) {
            Some(&i) => by_id[i].1.push(keyed.key.clone()),
            None => {
                index.insert(id, by_id.len());
                by_id.push((id.to_string(), vec![keyed.key.clone()]));
            }
        }
    }
    let mut taken: HashSet<String> = by_id.iter().map(|(id, _)| id.clone()).collect();
    by_id.sort_by(|a, b| cmp_utf16(&a.0, &b.0));
    let mut ids = HashMap::new();
    let mut renamed = Vec::new();
    for (id, mut keys) in by_id {
        keys.sort_by(|a, b| cmp_utf16(a, b));
        ids.insert(keys[0].clone(), id.clone());
        for key in &keys[1..] {
            let hex = &key["sha256:".len()..];
            let mut length = 8;
            while taken.contains(&format!("{id}~{}", &hex[..length.min(hex.len())])) {
                length += 4;
            }
            let as_id = format!("{id}~{}", &hex[..length.min(hex.len())]);
            taken.insert(as_id.clone());
            ids.insert(key.clone(), as_id.clone());
            renamed.push(Renamed { id: id.clone(), as_id, key: key.clone() });
        }
    }
    (ids, renamed)
}

/// The record with its id and references in the result's ids.
fn rewrite(keyed: &Keyed, ids: &HashMap<Hash, String>) -> Map {
    let mut record = keyed.record.clone();
    record.insert("id".into(), Value::String(ids[&keyed.key].clone()));
    for (field, key) in &keyed.refs {
        let id = key.as_ref().map_or(Value::Null, |k| Value::String(ids[k].clone()));
        if field == "of" {
            let native = Obj::new().spread(record.obj("native").unwrap_or(&Map::new())).set("of", id).value();
            record.insert("native".into(), native);
        } else {
            record.insert(field.clone(), id);
        }
    }
    record
}

/// Copies may disagree on header fields; the result takes the same one whatever the order of the copies.
fn pick_header(copies: &[Transcript]) -> Map {
    copies
        .iter()
        .map(|c| {
            let mut header = without_hash(&c.header);
            header.shift_remove("integrity");
            let text = canonical_json(&Value::Object(header.clone()));
            (header, text)
        })
        .min_by(|a, b| cmp_utf16(&a.1, &b.1))
        .map(|(h, _)| h)
        .unwrap_or_default()
}
