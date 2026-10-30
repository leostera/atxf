//! Record hashes, seals and inclusion proofs (SPEC §17).
//!
//! Every record's hash commits to its own content, to the header, and to the hash of every record it references.
//! References always point to earlier records, so a writer hashes each record as it appends it, and a record's
//! hash transitively covers everything it depends on, like a Git commit.

use std::collections::{HashMap, HashSet};

use crate::canonical::{canonical_json, sha256};
use crate::json::{self, Get, Map, Obj, Value};
use crate::transcript::{Error, Record, Transcript};

/// A hash: `sha256:` and 64 lowercase hex digits.
pub type Hash = String;

/// Fields whose value is the id of an earlier tree record. Their targets' hashes go into the referencing hash.
pub const REFERENCE_FIELDS: [&str; 5] = ["parentId", "targetId", "fromId", "firstKeptId", "restoreCheckpointId"];

const DOMAIN_TRANSCRIPT: &str = "atxf/0.1/transcript\n";
const DOMAIN_CONTENT: &str = "atxf/0.1/content\n";
const DOMAIN_RECORD: &str = "atxf/0.1/record\n";
const DOMAIN_CHAIN: &str = "atxf/0.1/chain\n";

/// The header's `integrity` declaration.
pub fn integrity_declaration() -> Value {
    Obj::new().set("alg", "sha256").set("canon", "jcs").value()
}

fn digest(domain: &str, text: &str) -> Hash {
    format!("sha256:{}", sha256(&format!("{domain}{text}")))
}

/// The record without its `hash`.
pub fn without_hash(record: &Map) -> Map {
    let mut out = record.clone();
    out.shift_remove("hash");
    out
}

pub fn hash_header(header: &Map) -> Hash {
    digest(DOMAIN_TRANSCRIPT, &canonical_json(&Value::Object(without_hash(header))))
}

/// Digest of a record's own fields. A proof carries this instead of the full record.
pub fn content_digest(record: &Map) -> Hash {
    digest(DOMAIN_CONTENT, &canonical_json(&Value::Object(without_hash(record))))
}

/// The reference fields present on a record, each with the referenced id (or `None` for `null`).
pub fn references_of(record: &Map) -> Vec<(&'static str, Option<String>)> {
    REFERENCE_FIELDS
        .iter()
        .filter_map(|&field| match record.field(field) {
            Some(Value::String(id)) => Some((field, Some(id.clone()))),
            Some(Value::Null) => Some((field, None)),
            _ => None,
        })
        .collect()
}

/// What a verifier needs to recompute a record's hash without its content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HashInput {
    pub transcript: Hash,
    pub content: Hash,
    /// Reference field → hash of the referenced record, or `None` for a null reference.
    pub refs: Vec<(String, Option<Hash>)>,
}

impl HashInput {
    pub fn to_value(&self) -> Value {
        let mut refs = Map::new();
        for (field, hash) in &self.refs {
            refs.insert(field.clone(), hash.clone().map_or(Value::Null, Value::String));
        }
        Obj::new()
            .set("transcript", self.transcript.as_str())
            .set("content", self.content.as_str())
            .set("refs", Value::Object(refs))
            .value()
    }

    pub fn from_value(value: &Value) -> Option<Self> {
        let refs = value
            .obj("refs")?
            .iter()
            .map(|(k, v)| match v {
                Value::Null => Some((k.clone(), None)),
                Value::String(h) => Some((k.clone(), Some(h.clone()))),
                _ => None,
            })
            .collect::<Option<_>>()?;
        Some(Self { transcript: value.str("transcript")?.to_string(), content: value.str("content")?.to_string(), refs })
    }
}

pub fn hash_from_input(input: &HashInput) -> Hash {
    digest(DOMAIN_RECORD, &canonical_json(&input.to_value()))
}

/// `resolve` maps a referenced id to that record's hash; it must know every earlier record.
pub fn hash_input(record: &Map, transcript: &str, resolve: impl Fn(&str) -> Option<Hash>) -> Result<HashInput, Error> {
    let mut refs = Vec::new();
    for (field, id) in references_of(record) {
        match id {
            None => refs.push((field.to_string(), None)),
            Some(id) => {
                let target = resolve(&id)
                    .ok_or_else(|| Error::new(format!("record `{}`: {field} `{id}` has no earlier hashed record", record.id())))?;
                refs.push((field.to_string(), Some(target)));
            }
        }
    }
    Ok(HashInput { transcript: transcript.to_string(), content: content_digest(record), refs })
}

pub fn hash_record(record: &Map, transcript: &str, resolve: impl Fn(&str) -> Option<Hash>) -> Result<Hash, Error> {
    Ok(hash_from_input(&hash_input(record, transcript, resolve)?))
}

pub fn chain_step(previous: &str, record_hash: &str) -> Hash {
    digest(DOMAIN_CHAIN, &format!("{previous}\n{record_hash}"))
}

/// What a `seal` record commits to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Commitment {
    pub count: usize,
    pub chain: Hash,
    pub heads: Vec<Hash>,
}

/// Incremental hasher for a transcript being written or read in file order.
#[derive(Clone, Debug)]
pub struct TranscriptHasher {
    pub header: Map,
    pub transcript_hash: Hash,
    hashes: HashMap<String, Hash>,
    referenced: HashSet<String>,
    dag_ids: Vec<String>,
    chain: Hash,
    count: usize,
}

impl TranscriptHasher {
    /// `header` without a hash; the hasher declares integrity on it and adds its hash.
    pub fn new(header: Map) -> Self {
        let mut header = Obj::new().spread(&header).set("integrity", integrity_declaration()).build();
        let transcript_hash = hash_header(&header);
        header.insert("hash".into(), Value::String(transcript_hash.clone()));
        Self {
            header,
            chain: transcript_hash.clone(),
            transcript_hash,
            hashes: HashMap::new(),
            referenced: HashSet::new(),
            dag_ids: Vec::new(),
            count: 0,
        }
    }

    pub fn hash_of(&self, id: &str) -> Option<&Hash> {
        self.hashes.get(id)
    }

    /// Hash the next record in file order, returning it with its hash.
    pub fn push(&mut self, record: &Map) -> Result<Map, Error> {
        let hash = hash_record(record, &self.transcript_hash, |id| self.hashes.get(id).cloned())?;
        if record.kind() != "seal" {
            for (_, id) in references_of(record) {
                if let Some(id) = id {
                    self.referenced.insert(id);
                }
            }
            self.dag_ids.push(record.id().to_string());
        }
        self.hashes.insert(record.id().to_string(), hash.clone());
        self.chain = chain_step(&self.chain, &hash);
        self.count += 1;
        let mut out = record.clone();
        out.insert("hash".into(), Value::String(hash));
        Ok(out)
    }

    /// The commitment a `seal` record appended now would carry.
    pub fn commitment(&self) -> Commitment {
        let mut heads: Vec<Hash> =
            self.dag_ids.iter().filter(|id| !self.referenced.contains(*id)).filter_map(|id| self.hashes.get(id).cloned()).collect();
        heads.sort_by(|a, b| json::cmp_utf16(a, b));
        Commitment { count: self.count, chain: self.chain.clone(), heads }
    }

    pub fn seal(&mut self, id: &str, time: &str) -> Map {
        let c = self.commitment();
        let record = Obj::new()
            .set("type", "seal")
            .set("id", id)
            .set("time", time)
            .set("count", json::number(c.count as f64))
            .set("chain", c.chain)
            .set("heads", Value::Array(c.heads.into_iter().map(Value::String).collect()))
            .build();
        // A seal references nothing, so hashing it cannot fail.
        self.push(&record).unwrap_or(record)
    }
}

/// A seal to append: its id and time.
#[derive(Clone, Debug)]
pub struct SealAt<'a> {
    pub id: &'a str,
    pub time: &'a str,
}

/// A copy of the transcript with `integrity` declared and every record hashed. Existing hashes are replaced.
pub fn add_integrity(transcript: &Transcript, seal: Option<SealAt<'_>>) -> Result<Transcript, Error> {
    let mut hasher = TranscriptHasher::new(without_hash(&transcript.header));
    let mut records = Vec::with_capacity(transcript.records.len() + 1);
    for record in &transcript.records {
        let unhashed = without_hash(record);
        // Seals depend on what precedes them, so they are recomputed rather than rehashed.
        records.push(if unhashed.kind() == "seal" { hasher.seal(unhashed.id(), unhashed.time()) } else { hasher.push(&unhashed)? });
    }
    if let Some(seal) = seal {
        records.push(hasher.seal(seal.id, seal.time));
    }
    Ok(Transcript { header: hasher.header, records })
}

/// A hash or seal that does not verify.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntegrityProblem {
    /// Index into `transcript.records`, or `None` for the header.
    pub index: Option<usize>,
    pub message: String,
}

/// Check every hash and seal of a transcript whose header declares `integrity`.
pub fn verify_integrity(transcript: &Transcript) -> Vec<IntegrityProblem> {
    let mut problems = Vec::new();
    let problem = |index: Option<usize>, message: &str| IntegrityProblem { index, message: message.to_string() };
    if transcript.header.field("integrity").is_none() {
        for (index, record) in transcript.records.iter().enumerate() {
            if record.kind() == "seal" {
                problems.push(problem(Some(index), "seal requires `integrity` in the header"));
            }
        }
        return problems;
    }
    let mut hasher = TranscriptHasher::new(without_hash(&transcript.header));
    if transcript.header.str("hash") != Some(hasher.transcript_hash.as_str()) {
        problems.push(problem(None, "header hash does not match its content"));
    }
    for (index, record) in transcript.records.iter().enumerate() {
        if record.kind() == "seal" {
            let expected = hasher.commitment();
            if json::as_f64(record.field("count").unwrap_or(&Value::Null)) != Some(expected.count as f64) {
                let count = record.field("count").map_or_else(|| "undefined".to_string(), json::to_js_string);
                problems.push(problem(Some(index), &format!("seal count is {count}, expected {}", expected.count)));
            }
            if record.str("chain") != Some(expected.chain.as_str()) {
                problems.push(problem(Some(index), "seal chain does not match the records before it"));
            }
            let heads = Value::Array(expected.heads.iter().cloned().map(Value::String).collect());
            if record.field("heads").map(json::stringify) != Some(json::stringify(&heads)) {
                problems.push(problem(Some(index), "seal heads do not match the records before it"));
            }
        }
        let computed = match hasher.push(&without_hash(record)) {
            Ok(hashed) => hashed.str("hash").unwrap_or("").to_string(),
            Err(error) => {
                problems.push(problem(Some(index), &error.0));
                continue;
            }
        };
        match record.field("hash") {
            None => problems.push(problem(Some(index), "missing hash; the header declares `integrity`")),
            Some(hash) if hash.as_str() != Some(computed.as_str()) => {
                problems.push(problem(Some(index), "hash does not match the record's content and references"))
            }
            _ => {}
        }
    }
    problems
}

/// A proof that `record` is covered by `head`, a hash listed in a seal. `steps[0]` is the record's own hash input;
/// each later step is the hash input of a record that references the one before it, ending at the head.
#[derive(Clone, Debug, PartialEq)]
pub struct InclusionProof {
    pub record: Map,
    pub steps: Vec<HashInput>,
    pub head: Hash,
}

impl InclusionProof {
    pub fn to_value(&self) -> Value {
        Obj::new()
            .set("record", Value::Object(self.record.clone()))
            .set("steps", Value::Array(self.steps.iter().map(HashInput::to_value).collect()))
            .set("head", self.head.as_str())
            .value()
    }
}

pub fn verify_inclusion(proof: &InclusionProof) -> bool {
    let Some(first) = proof.steps.first() else { return false };
    if first.content != content_digest(&proof.record) {
        return false;
    }
    let mut current = hash_from_input(first);
    for step in &proof.steps[1..] {
        if step.transcript != first.transcript || !step.refs.iter().any(|(_, h)| h.as_deref() == Some(current.as_str())) {
            return false;
        }
        current = hash_from_input(step);
    }
    current == proof.head
}

/// Build an inclusion proof for record `id`, walking forward through referencing records until a head.
pub fn prove_inclusion(transcript: &Transcript, id: &str) -> Result<InclusionProof, Error> {
    let mut hasher = TranscriptHasher::new(without_hash(&transcript.header));
    let mut inputs: HashMap<String, HashInput> = HashMap::new();
    let mut referenced_by: HashMap<String, String> = HashMap::new();
    let mut by_id: HashMap<String, Map> = HashMap::new();
    for record in &transcript.records {
        let unhashed = without_hash(record);
        let input = hash_input(&unhashed, &hasher.transcript_hash, |r| hasher.hash_of(r).cloned())?;
        inputs.insert(record.id().to_string(), input);
        if record.kind() == "seal" {
            hasher.seal(record.id(), record.time());
        } else {
            hasher.push(&unhashed)?;
        }
        by_id.insert(record.id().to_string(), unhashed.clone());
        if record.kind() == "seal" {
            continue;
        }
        for (_, target) in references_of(&unhashed) {
            // The first referencing record is enough; any path to a head proves inclusion.
            if let Some(target) = target.filter(|t| !t.is_empty()) {
                referenced_by.entry(target).or_insert_with(|| record.id().to_string());
            }
        }
    }
    let record = by_id.get(id).filter(|r| r.kind() != "seal").ok_or_else(|| Error::new(format!("no hashable record `{id}`")))?;
    let mut steps = Vec::new();
    let mut cursor = Some(id.to_string());
    while let Some(current) = cursor {
        steps.push(inputs[&current].clone());
        cursor = referenced_by.get(&current).cloned();
    }
    let head = hash_from_input(steps.last().expect("a proof has the record's own step"));
    Ok(InclusionProof { record: record.clone(), steps, head })
}
