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

use crate::canonical::{canonical_json, sha256, sha256_hex, write_canonical};
use crate::integrity::{Hash, IntegrityProblem, REFERENCE_FIELDS, SealAt, add_integrity_owned, verify_integrity, without_hash};
use crate::json::{Get, Map, Obj, Value, cmp_utf16, write_string};
use crate::time;
use crate::transcript::{Error, Record, Transcript};
use crate::tree::{active_path, index_tree};

const DOMAIN: &str = "atxf/0.1/reconcile\n";

/// Two inputs that hold the same conversation read in different ways: they share no record, yet the model's first
/// answer on the active path is the same in both. A lossy conversion (one without carry) changes every record's key,
/// so their union would hold the conversation twice. Copies forked before the first answer each have their own.
///
/// Only inputs that should share records are compared: copies of one transcript, and a fork with the transcript it
/// links to.
fn read_twice(copies: &[Transcript], keyed: &[Vec<Keyed<'_>>], targets: &HashMap<usize, Vec<usize>>) -> Option<(usize, usize)> {
    let keys: Vec<HashSet<&str>> = keyed.iter().map(|records| records.iter().map(|k| k.key.as_str()).collect()).collect();
    let answers: Vec<Option<String>> = copies.iter().map(first_answer).collect();
    let forks_of = |child: usize, of: usize| {
        targets.get(&child).is_some_and(|t| t.contains(&of)) && copies[child].header.obj("parent").and_then(|p| p.str("entryId")).is_none()
    };
    let should_share = |a: usize, b: usize| copies[a].id() == copies[b].id() || forks_of(b, a) || forks_of(a, b);
    for a in 0..copies.len() {
        for b in (a + 1)..copies.len() {
            if should_share(a, b) && answers[a].is_some() && answers[a] == answers[b] && keys[a].is_disjoint(&keys[b]) {
                return Some((a, b));
            }
        }
    }
    None
}

/// The text of the first assistant message with any on the active path: what a lossy conversion writes.
fn first_answer(copy: &Transcript) -> Option<String> {
    let index = index_tree(copy);
    active_path(&index).into_iter().filter(|r| r.kind() == "message" && r.str("role") == Some("assistant")).find_map(|record| {
        let parts: Vec<&str> = record
            .arr("content")
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| b.as_object())
                    .filter(|b| b.str("type") == Some("text"))
                    .filter_map(|b| b.str("text"))
                    .filter(|t| !t.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        (!parts.is_empty()).then(|| parts.join("\n"))
    })
}

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
struct Keyed<'a> {
    key: Hash,
    /// The record as in its copy, `hash` included.
    record: &'a Map,
    /// Reference field → the referenced record's key; `native.of` is under `of`.
    refs: Vec<(String, Option<Hash>)>,
    time: f64,
}

/// The reconciliation key of every record of a copy, except seals: a digest of the record's content without its
/// id, its hash or the ids it references, and of the keys of the records it references.
fn key_copy<'a>(copy: &'a Transcript, graft: Option<&Graft>) -> Result<(Vec<Keyed<'a>>, HashMap<&'a str, Hash>), Error> {
    let mut key_of: HashMap<&str, Hash> = HashMap::new();
    let mut out = Vec::new();
    for (index, record) in copy.records.iter().enumerate() {
        if key_of.contains_key(record.id()) {
            return Err(Error::new(format!("a copy of `{}` has two records with id `{}`", copy.id(), record.id())));
        }
        if record.kind() == "seal" {
            continue;
        }
        let resolve = |field: &str, id: &str| {
            key_of
                .get(id)
                .cloned()
                .ok_or_else(|| Error::new(format!("a copy of `{}`, record {}: {field} `{id}` has no earlier record", copy.id(), index + 1)))
        };
        // The content is the record without `hash`, with its id, the ids it references and `native.of` blanked.
        let mut refs: Vec<(String, Option<Hash>)> = Vec::new();
        let mut content: Vec<(&str, Field<'_>)> = Vec::with_capacity(record.len() + 1);
        for field in REFERENCE_FIELDS {
            match record.field(field) {
                Some(Value::Null) => refs.push((field.to_string(), None)),
                Some(Value::String(id)) => refs.push((field.to_string(), Some(resolve(field, id)?))),
                _ => {}
            }
        }
        if let Some(native) = record.obj("native")
            && let Some(of) = native.field("of")
        {
            let of = of
                .as_str()
                .ok_or_else(|| Error::new(format!("a copy of `{}`, record {}: native.of is not an id", copy.id(), index + 1)))?;
            refs.push(("of".to_string(), Some(resolve("native.of", of)?)));
        }
        for (key, value) in record {
            content.push(match (key.as_str(), value) {
                ("hash", _) => continue,
                ("id", _) => (key, Field::Blank),
                (field, Value::String(_)) if REFERENCE_FIELDS.contains(&field) => (key, Field::Blank),
                ("native", Value::Object(native)) if native.has("of") => (key, Field::ObjectBlanking(native, "of")),
                _ => (key, Field::Value(value)),
            });
        }
        if !record.has("id") {
            content.push(("id", Field::Blank));
        }
        let mut key = digest(&content, &refs);
        // A root the linked transcript does not share hangs under its graft point, keyed as it stands in the result.
        if let Some(graft) = graft
            && refs.iter().any(|(field, key)| field == "parentId" && key.is_none())
            && !graft.shared.contains(&key)
        {
            for (field, value) in content.iter_mut() {
                if *field == "parentId" {
                    *value = Field::Blank;
                }
            }
            for (field, value) in refs.iter_mut() {
                if field == "parentId" {
                    *value = Some(graft.key.clone());
                }
            }
            key = digest(&content, &refs);
        }
        key_of.insert(record.id(), key.clone());
        out.push(Keyed { key, record, refs, time: time::parse(record.time()).unwrap_or(f64::NEG_INFINITY) });
    }
    Ok((out, key_of))
}

/// The key of a record's content and the keys it references: the digest of the canonical JSON of `{content, refs}`.
fn digest(content: &[(&str, Field<'_>)], refs: &[(String, Option<Hash>)]) -> Hash {
    let mut ref_map = Map::new();
    for (field, key) in refs {
        ref_map.insert(field.clone(), key.clone().map_or(Value::Null, Value::String));
    }
    let mut text = String::from(DOMAIN);
    text.push_str("{\"content\":");
    write_fields(&mut text, content);
    text.push_str(",\"refs\":");
    write_canonical(&mut text, &Value::Object(ref_map));
    text.push('}');
    format!("sha256:{}", sha256_hex(text.as_bytes()))
}

/// Where a linked transcript's new roots go: the key of the record they hang under, and the keys of the records it
/// links to, among which a root is shared and stays a root.
struct Graft {
    key: Hash,
    shared: HashSet<Hash>,
}

/// A field of an object written as canonical JSON with some values replaced, without copying the object.
enum Field<'a> {
    Value(&'a Value),
    /// The empty string.
    Blank,
    /// The object with its field named by the `&str` blanked.
    ObjectBlanking(&'a Map, &'a str),
}

fn write_fields(out: &mut String, fields: &[(&str, Field<'_>)]) {
    let mut fields: Vec<&(&str, Field<'_>)> = fields.iter().collect();
    fields.sort_by(|(a, _), (b, _)| cmp_utf16(a, b));
    out.push('{');
    for (i, (key, field)) in fields.into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_string(out, key);
        out.push(':');
        match field {
            Field::Value(value) => write_canonical(out, value),
            Field::Blank => out.push_str("\"\""),
            Field::ObjectBlanking(map, blank) => {
                let inner: Vec<(&str, Field<'_>)> =
                    map.iter().map(|(k, v)| (k.as_str(), if k == blank { Field::Blank } else { Field::Value(v) })).collect();
                write_fields(out, &inner)
            }
        }
    }
    out.push('}');
}

/// The reconciliation keys of a transcript's records. Two copies are in sync when their sets of keys are equal.
pub fn reconciliation_keys(transcript: &Transcript) -> Result<HashSet<Hash>, Error> {
    Ok(key_copy(transcript, None)?.0.into_iter().map(|k| k.key).collect())
}

/// Whether two copies hold the same records, whatever their ids, order, hashes or seals.
pub fn in_sync(a: &Transcript, b: &Transcript) -> Result<bool, Error> {
    Ok(reconciliation_keys(a)? == reconciliation_keys(b)?)
}

/// Reconcile copies of one session into one transcript that keeps every record of every copy. The result is hashed
/// and sealed when `integrity` says so, or by default when any copy declares integrity.
pub fn reconcile(copies: &[Transcript], integrity: Option<bool>) -> Result<ReconcileResult, Error> {
    if copies.is_empty() {
        return Err(Error::new("reconcile needs at least one copy"));
    }
    let Arranged { session_id, roots, order, targets } = arrange(copies)?;
    let problems = copies
        .iter()
        .enumerate()
        .filter(|(_, c)| c.header.has("integrity"))
        .map(|(i, c)| (i, verify_integrity(c)))
        .filter(|(_, p)| !p.is_empty())
        .collect();

    // Each transcript is keyed after the ones it links to, so its graft point has a key.
    let mut keyed: Vec<Option<Vec<Keyed<'_>>>> = (0..copies.len()).map(|_| None).collect();
    let mut key_of: Vec<Option<HashMap<&str, Hash>>> = (0..copies.len()).map(|_| None).collect();
    for &index in &order {
        let graft = graft_for(&copies[index], targets.get(&index).map(Vec::as_slice).unwrap_or_default(), &keyed, &key_of);
        let (records, keys) = key_copy(&copies[index], graft.as_ref())?;
        keyed[index] = Some(records);
        key_of[index] = Some(keys);
    }
    let keyed: Vec<Vec<Keyed<'_>>> = keyed.into_iter().map(Option::unwrap_or_default).collect();
    if let Some((a, b)) = read_twice(copies, &keyed, &targets) {
        return Err(Error::new(format!(
            "copies {} and {} of `{}` hold the same conversation but share no record: one was read differently (converted without carry?), and reconciling them would hold it twice",
            a + 1,
            b + 1,
            session_id
        )));
    }

    let mut by_key: HashMap<Hash, Keyed<'_>> = HashMap::new();
    for records in keyed {
        for keyed in records {
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
    let root_copies: Vec<Transcript> = roots.iter().map(|&i| copies[i].clone()).collect();
    let mut header = pick_header(&root_copies);
    let mut merged: Vec<&str> = copies.iter().flat_map(known).filter(|id| *id != session_id).collect();
    merged.sort_by(|a, b| cmp_utf16(a, b));
    merged.dedup();
    header.shift_remove("merged");
    if !merged.is_empty() {
        header.insert("merged".into(), Value::Array(merged.into_iter().map(|id| Value::String(id.to_string())).collect()));
    }
    let transcript = Transcript { header, records };
    let integrity = integrity.unwrap_or_else(|| copies.iter().any(|c| c.header.has("integrity")));
    if !integrity {
        return Ok(ReconcileResult { transcript, renamed, problems });
    }
    let mut keys: Vec<&str> = ordered.iter().map(|k| k.key.as_str()).collect();
    keys.sort_by(|a, b| cmp_utf16(a, b));
    let last = ordered.last().map_or_else(|| transcript.header.str("time").unwrap_or("").to_string(), |k| k.record.time().to_string());
    let seal_id = format!("seal~{}", &sha256(&keys.join("\n"))[..12]);
    let sealed = add_integrity_owned(transcript, Some(SealAt { id: &seal_id, time: &last }))?;
    Ok(ReconcileResult { transcript: sealed, renamed, problems })
}

/// The ids a transcript stands for: its own, and those reconciled into it.
fn known(copy: &Transcript) -> Vec<&str> {
    let mut ids = vec![copy.id()];
    if let Some(merged) = copy.header.arr("merged") {
        ids.extend(merged.iter().filter_map(Value::as_str));
    }
    ids
}

struct Arranged {
    session_id: String,
    roots: Vec<usize>,
    order: Vec<usize>,
    targets: HashMap<usize, Vec<usize>>,
}

/// Which inputs are copies of the session and which link to it, as `arrange` in `reconcile.ts`.
fn arrange(copies: &[Transcript]) -> Result<Arranged, Error> {
    let mut targets: HashMap<usize, Vec<usize>> = HashMap::new();
    for (index, copy) in copies.iter().enumerate() {
        let Some(parent) = copy.header.obj("parent").and_then(|p| p.str("transcriptId")) else { continue };
        let to: Vec<usize> = copies
            .iter()
            .enumerate()
            .filter(|(at, other)| *at != index && other.id() != copy.id() && known(other).contains(&parent))
            .map(|(at, _)| at)
            .collect();
        if !to.is_empty() {
            targets.insert(index, to);
        }
    }
    let roots: Vec<usize> = (0..copies.len()).filter(|i| !targets.contains_key(i)).collect();
    let Some(&first) = roots.first() else {
        return Err(Error::new("reconcile needs a session the others link to, and every input links to another"));
    };
    let session_id = copies[first].id().to_string();
    for &index in &roots {
        if copies[index].id() != session_id {
            return Err(Error::new(format!("copies of different sessions: `{}` and `{}`", session_id, copies[index].id())));
        }
    }
    let mut order = roots.clone();
    let mut placed: HashSet<usize> = roots.iter().copied().collect();
    // In input order, as the TypeScript `Map` iterates.
    let mut linked: Vec<usize> = targets.keys().copied().collect();
    linked.sort_unstable();
    let mut grew = true;
    while grew {
        grew = false;
        for &index in &linked {
            if placed.contains(&index)
                || !targets[&index].iter().all(|at| placed.contains(at) || targets.get(at).is_some_and(|t| t.contains(&index)))
            {
                continue;
            }
            order.push(index);
            placed.insert(index);
            grew = true;
        }
    }
    for &index in &linked {
        if !placed.contains(&index) {
            order.push(index);
        }
    }
    Ok(Arranged { session_id, roots, order, targets })
}

/// Where a linked transcript's new roots go: the record `parent.entryId` names in the inputs it links to (the
/// smallest key when they disagree).
fn graft_for(
    copy: &Transcript,
    targets: &[usize],
    keyed: &[Option<Vec<Keyed<'_>>>],
    key_of: &[Option<HashMap<&str, Hash>>],
) -> Option<Graft> {
    let entry = copy.header.obj("parent").and_then(|p| p.str("entryId"))?;
    let mut candidates: Vec<&Hash> = targets.iter().filter_map(|&at| key_of[at].as_ref().and_then(|keys| keys.get(entry))).collect();
    candidates.sort_by(|a, b| cmp_utf16(a, b));
    let key = (*candidates.first()?).clone();
    let shared = targets.iter().flat_map(|&at| keyed[at].iter().flatten().map(|k| k.key.clone())).collect();
    Some(Graft { key, shared })
}

/// Orders the heap so the earliest, then smallest key, pops first.
struct Ready<'a>(Keyed<'a>);

impl PartialEq for Ready<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Ready<'_> {}
impl PartialOrd for Ready<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Ready<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reversed: BinaryHeap is a max-heap.
        other.0.time.total_cmp(&self.0.time).then_with(|| cmp_utf16(&other.0.key, &self.0.key))
    }
}

/// References first; among the records whose references are all written, the earliest, then the smallest key.
fn topological_order(records: Vec<Keyed<'_>>) -> Vec<Keyed<'_>> {
    let mut waiting: HashMap<Hash, usize> = HashMap::new();
    let mut dependents: HashMap<Hash, Vec<Hash>> = HashMap::new();
    for keyed in &records {
        let deps: HashSet<&Hash> = keyed.refs.iter().filter_map(|(_, r)| r.as_ref()).collect();
        waiting.insert(keyed.key.clone(), deps.len());
        for dep in deps {
            dependents.entry(dep.clone()).or_default().push(keyed.key.clone());
        }
    }
    let mut pending: HashMap<Hash, Keyed<'_>> = HashMap::new();
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
fn assign_ids(records: &[Keyed<'_>]) -> (HashMap<Hash, String>, Vec<Renamed>) {
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
fn rewrite(keyed: &Keyed<'_>, ids: &HashMap<Hash, String>) -> Map {
    let mut record = keyed.record.clone();
    record.shift_remove("hash");
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
