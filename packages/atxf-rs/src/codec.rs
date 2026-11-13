//! Lossless converters built from a format's pieces (SPEC §11.1).
//!
//! - **Native in, native out.** `decode` puts every unit of a source file into exactly one record's `native`. A
//!   transcript that still prints the file it was read from is written back from its native records, byte for
//!   byte.
//! - **Anything else out.** `encode` writes the format's own records for the transcript's active context, so the
//!   agent can continue it. Each written record is marked with the ATXF id it stands for, and the whole transcript
//!   rides along in a carrier the agent ignores.
//! - **Carried transcript in.** Reading such a file returns the carried transcript unchanged. Records without a
//!   mark were appended by the agent afterwards; they are decoded and attached through the marks.

use std::collections::{HashMap, HashSet};

use crate::canonical::{canonical_json, sha256};
use crate::integrity::{add_integrity_owned, without_hash};
use crate::json::{Get, Map, Obj, Value, cmp_utf16};

fn sorted(mut keys: Vec<&String>) -> Vec<&String> {
    keys.sort_by(|a, b| cmp_utf16(a, b));
    keys
}

fn opt_value(value: Option<&str>) -> Value {
    value.map_or(Value::Null, |s| Value::String(s.to_string()))
}
use crate::native::{Framing, Unit, is_pure_native, native_units};
use crate::transcript::{Error, Record, Transcript};
use crate::tree::index_tree;

/// A converter between one agent's native session format and ATXF.
///
/// Both directions are lossless: `from_atxf(to_atxf(x))` reproduces `x` byte for byte, and `to_atxf(from_atxf(t))`
/// returns `t` for any transcript, because a file written for another agent's transcript carries it along.
pub trait Converter: Sync {
    /// The agent name used in `source.agent` and `native.source`, e.g. `pi`.
    fn agent(&self) -> &'static str;
    /// The native format identifier, e.g. `pi/session-jsonl`.
    fn format(&self) -> &'static str;
    /// Parses native session text into a transcript. Records are hashed (SPEC §17) unless `integrity` is false.
    fn to_atxf(&self, text: &str, integrity: bool) -> Result<Transcript, Error>;
    /// Writes a transcript as native session text. With `carry: false`, writes only the agent's own records for the
    /// active context, without marks or the carried transcript: a clean file that no longer round-trips.
    #[allow(clippy::wrong_self_convention)] // Named as in the TypeScript API.
    fn from_atxf(&self, transcript: &Transcript, carry: bool) -> Result<String, Error> {
        self.from_atxf_for(transcript, carry, None)
    }
    /// Like `from_atxf`, for a file that will be loaded as the native session `session_id` when that is not the
    /// transcript's own session, e.g. when an agent replaces one of its sessions with a shared transcript. Formats
    /// whose ids must be unique across sessions derive their ids from it. `None` means the transcript's
    /// `source.sessionId`, else its id. (`sessionId` of `FromAtxfOptions` in the TypeScript API.)
    #[allow(clippy::wrong_self_convention)]
    fn from_atxf_for(&self, transcript: &Transcript, carry: bool, session_id: Option<&str>) -> Result<String, Error>;
    /// Writes every record of the transcript as native session text, without the carried transcript (SPEC §11.2):
    /// a record read from this format is written as the entry it was read from. `None` for a format that cannot
    /// hold a tree. (`carry: false, tree: true` in the TypeScript API.)
    #[allow(clippy::wrong_self_convention)]
    fn from_atxf_tree(&self, transcript: &Transcript) -> Option<String>;
}

/// A native unit written by `FormatSpec::encode_tree`: a value, or the exact text of a line that was not JSON.
#[derive(Clone, Debug)]
pub enum TreeUnit {
    Value(Value),
    Raw(String),
}

/// A native record written for an ATXF transcript, with the ATXF record it stands for (`None` for one with no
/// single counterpart).
#[derive(Clone, Debug)]
pub struct Encoded {
    pub value: Value,
    pub source: Option<String>,
}

/// Decoding state handed to a format's `decode`.
pub struct DecodeContext<'a> {
    /// Unit index → ATXF id of a unit written by `encode` (`None` when it stands for no single record).
    pub known: HashMap<usize, Option<String>>,
    /// The carried transcript, when continuing one.
    pub base: Option<&'a Transcript>,
    /// Allocates record ids, already holding the carried transcript's ids.
    pub ids: IdAllocator,
}

/// What a format's `decode` returns.
pub struct Decoded {
    pub header: Map,
    pub records: Vec<Map>,
}

/// The pieces of a lossless converter for one format.
pub trait FormatSpec: Sync {
    const AGENT: &'static str;
    const FORMAT: &'static str;
    fn framing(&self) -> &dyn Framing;
    /// Native units to ATXF. Units in `context.known` were written by `encode` and are already in the carried
    /// transcript: skip them, but resolve references to them through their ATXF ids. Every other unit must end up
    /// in exactly one returned record's `native`, in order.
    fn decode(&self, units: &[Unit], context: DecodeContext<'_>) -> Decoded;
    /// The format's records for the transcript's active context. `session_id` is the native session the records
    /// will be loaded as (see `Converter::from_atxf_for`).
    fn encode(&self, transcript: &Transcript, session_id: Option<&str>) -> Vec<Encoded>;
    /// Every record of the transcript, in file order, for formats that can hold a tree. A record read from this
    /// format is written as the entry it was read from, restored with what it keeps in `ext.<agent>.patch`.
    fn encode_tree(&self, _transcript: &Transcript) -> Option<Vec<TreeUnit>> {
        None
    }
    /// The value with a mark naming the ATXF record it stands for.
    fn mark(&self, value: Value, source: Option<&str>) -> Value;
    /// The mark's ATXF id: `Some(Some(id))`, `Some(None)` for a mark without one, `None` for an unmarked record.
    fn mark_of(&self, value: &Value) -> Option<Option<String>>;
    /// Adds the carried transcript to the encoded (and marked) records.
    fn attach(&self, values: Vec<Value>, transcript: &Transcript) -> Vec<Value>;
    /// Finds the carried transcript, takes it out of `units` and returns it. The units left are those an unmarked
    /// file would have, with any mark in place.
    fn detach(&self, units: &mut Vec<Unit>) -> Option<Value>;
}

/// The digest of a native file, recorded in `fidelity.nativeDigest` of the transcript read from it.
pub fn native_digest(text: &str) -> String {
    format!("sha256:{}", sha256(text))
}

/// The mark key's id: `{atxf: {id}}` → `Some(id or None)`; only a string counts as an id.
pub fn mark_id(atxf: Option<&Map>) -> Option<Option<String>> {
    let atxf = atxf?;
    atxf.has("id").then(|| atxf.str("id").map(str::to_string))
}

fn same_records(a: &Transcript, b: &Transcript) -> bool {
    if a.records.len() != b.records.len() {
        return false;
    }
    let header = |h: &Map| {
        let mut h = without_hash(h);
        h.shift_remove("integrity");
        canonical_json(&Value::Object(h))
    };
    if header(&a.header) != header(&b.header) {
        return false;
    }
    a.records
        .iter()
        .zip(&b.records)
        .all(|(x, y)| canonical_json(&Value::Object(without_hash(x))) == canonical_json(&Value::Object(without_hash(y))))
}

impl<T: FormatSpec> Converter for T {
    fn agent(&self) -> &'static str {
        T::AGENT
    }

    fn format(&self) -> &'static str {
        T::FORMAT
    }

    fn to_atxf(&self, text: &str, integrity: bool) -> Result<Transcript, Error> {
        let mut units = self.framing().parse(text);
        let Some(carried) = self.detach(&mut units) else {
            let decoded = self.decode(&units, DecodeContext { known: HashMap::new(), base: None, ids: IdAllocator::default() });
            let fidelity =
                Obj::new().spread(decoded.header.obj("fidelity").unwrap_or(&Map::new())).set("nativeDigest", native_digest(text)).value();
            let header = Obj::new().spread(&decoded.header).set("fidelity", fidelity).build();
            let transcript = Transcript { header, records: decoded.records };
            return if integrity { add_integrity_owned(transcript, None) } else { Ok(transcript) };
        };
        let base = Transcript::from_value_owned(carried)?;
        let mut known = HashMap::new();
        for (index, unit) in units.iter().enumerate() {
            if let Some(mark) = self.mark_of(&unit.value) {
                known.insert(index, mark);
            }
        }
        if known.len() == units.len() {
            return Ok(base);
        }
        // The last record the encoder wrote stands for where the transcript is now: whatever the agent appended
        // after it continues from the active leaf, which may lie past the last context message.
        if let Some(&last) = known.keys().max() {
            known.insert(last, index_tree(&base).active_leaf.map(str::to_string));
        }
        let ids = IdAllocator::new(base.records.iter().map(|r| r.id().to_string()));
        let decoded = self.decode(&units, DecodeContext { known, base: Some(&base), ids });
        let Transcript { header, mut records } = base;
        records.extend(decoded.records);
        let integrity = header.has("integrity");
        let transcript = Transcript { header, records };
        if integrity { add_integrity_owned(transcript, None) } else { Ok(transcript) }
    }

    fn from_atxf_for(&self, transcript: &Transcript, carry: bool, session_id: Option<&str>) -> Result<String, Error> {
        let framing = self.framing();
        // Native records hold the ids of the session they were read from, so they stand for the transcript only
        // when the file is loaded as that same session.
        let same_session = session_id.is_none() || session_id == transcript.header.obj("source").and_then(|source| source.str("sessionId"));
        if carry && same_session && is_pure_native(transcript, T::AGENT) {
            // Native records alone stand for the transcript only if reading them back gives it: a reconciled
            // transcript holds only native records too, but its branches may not fit one file of a linear format.
            // Reading is deterministic, so printing the very file the transcript was read from is enough.
            let text = framing.print(&native_units(transcript, framing));
            let reproduces = match transcript.header.obj("fidelity").and_then(|f| f.field("nativeDigest")) {
                Some(digest) => digest.as_str() == Some(native_digest(&text).as_str()),
                None => same_records(&self.to_atxf(&text, false)?, transcript),
            };
            if reproduces {
                return Ok(text);
            }
        }
        let encoded = self.encode(transcript, session_id);
        let values = if carry {
            let marked = encoded.into_iter().map(|e| self.mark(e.value, e.source.as_deref())).collect();
            self.attach(marked, transcript)
        } else {
            encoded.into_iter().map(|e| e.value).collect()
        };
        let units: Vec<Unit> = values.into_iter().map(|value| Unit { raw: framing.canonical(&value), value }).collect();
        Ok(framing.print(&units))
    }

    fn from_atxf_tree(&self, transcript: &Transcript) -> Option<String> {
        let framing = self.framing();
        let units: Vec<Unit> = self
            .encode_tree(transcript)?
            .into_iter()
            .map(|unit| match unit {
                TreeUnit::Value(value) => Unit { raw: framing.canonical(&value), value },
                TreeUnit::Raw(text) => Unit { raw: format!("{text}\n"), value: Value::Null },
            })
            .collect();
        Some(framing.print(&units))
    }
}

/// The carried transcript as one JSON value: the header and records, in order.
pub fn carried_value(transcript: &Transcript) -> Value {
    transcript.to_value()
}

/// Builds ids that never collide within one transcript.
#[derive(Clone, Debug, Default)]
pub struct IdAllocator {
    used: HashSet<String>,
}

impl IdAllocator {
    pub fn new(existing: impl IntoIterator<Item = String>) -> Self {
        Self { used: existing.into_iter().collect() }
    }

    /// Every id taken, in UTF-16 order.
    pub fn taken(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.used.iter().cloned().collect();
        ids.sort_by(|a, b| cmp_utf16(a, b));
        ids
    }

    /// `preferred` when free, otherwise `preferred-2`, `preferred-3`, …
    pub fn take(&mut self, preferred: &str) -> String {
        let mut id = preferred.to_string();
        let mut n = 2;
        while self.used.contains(&id) {
            id = format!("{preferred}-{n}");
            n += 1;
        }
        self.used.insert(id.clone());
        id
    }
}

/// Tracks the records a decoder has produced, so references can be resolved and checked. Native ids map to the
/// ATXF tree record they resolve to: a tree record maps to itself; an annotation, or a unit written by `encode`
/// without a single counterpart, maps to the record its parent resolves to.
pub struct TreeBuilder<'a> {
    pub records: Vec<Map>,
    pub context: DecodeContext<'a>,
    resolved: HashMap<String, Option<String>>,
    parents: HashMap<String, Option<String>>,
    types: HashMap<String, String>,
    /// Tool call id → the assistant messages holding it, in order. Ids are unique along a path, not across branches.
    tool_calls: HashMap<String, Vec<String>>,
    /// The last tree record, in file order: the parent for formats without explicit parent links.
    pub last: Option<String>,
    /// The carried transcript's active leaf, in a continuation.
    continues_from: Option<String>,
    /// Whether `records` keeps what is pushed; not when reading a file of any length as a stream.
    retain: bool,
}

impl<'a> TreeBuilder<'a> {
    pub fn new(context: DecodeContext<'a>) -> Self {
        let mut tree = Self {
            records: Vec::new(),
            resolved: HashMap::new(),
            parents: HashMap::new(),
            types: HashMap::new(),
            tool_calls: HashMap::new(),
            last: None,
            continues_from: None,
            retain: true,
            context,
        };
        if let Some(base) = tree.context.base {
            for record in &base.records {
                tree.observe(record);
            }
            // A continuation picks up where the carried transcript is: its active leaf.
            let leaf = index_tree(base).active_leaf.map(str::to_string);
            tree.last.clone_from(&leaf);
            tree.continues_from = leaf;
        }
        tree
    }

    fn observe(&mut self, record: &Map) {
        if record.is_tree() {
            self.parents.insert(record.id().to_string(), record.parent_id().map(str::to_string));
            self.types.insert(record.id().to_string(), record.kind().to_string());
            self.last = Some(record.id().to_string());
        }
        if record.kind() == "message" && record.is("role", "assistant") {
            for block in record.arr("content").into_iter().flatten() {
                if block.is("type", "tool_call")
                    && let Some(id) = block.str("id")
                {
                    self.tool_calls.entry(id.to_string()).or_default().push(record.id().to_string());
                }
            }
        }
    }

    /// Maps a native id to the ATXF tree record it resolves to.
    pub fn alias(&mut self, native_id: Option<&Value>, atxf_id: Option<String>) {
        if let Some(Value::String(id)) = native_id {
            self.resolved.insert(id.clone(), atxf_id);
        }
    }

    /// The ATXF tree record a native reference points to, or `None` when unknown.
    pub fn resolve(&self, native_id: Option<&Value>) -> Option<String> {
        match native_id {
            Some(Value::String(id)) => self.resolved.get(id).cloned().flatten(),
            _ => None,
        }
    }

    /// The ATXF parent for a native parent reference. In a continuation, everything the agent appended continues
    /// the carried transcript, so a native root (`null`) is where the transcript is: its active leaf.
    pub fn parent_of(&self, native_id: Option<&Value>) -> Option<String> {
        if matches!(native_id, Some(Value::Null)) && self.context.base.is_some() {
            return self.continues_from.clone();
        }
        self.resolve(native_id)
    }

    /// Whether `native_id` has been seen, even if it resolves to no record.
    pub fn knows(&self, native_id: Option<&Value>) -> bool {
        matches!(native_id, Some(Value::String(id)) if self.resolved.contains_key(id))
    }

    pub fn is_node(&self, id: Option<&str>) -> bool {
        id.is_some_and(|id| self.parents.contains_key(id))
    }

    pub fn type_of(&self, id: &str) -> Option<&str> {
        self.types.get(id).map(String::as_str)
    }

    pub fn is_ancestor(&self, ancestor: &str, of: Option<&str>) -> bool {
        let mut seen = HashSet::new();
        let mut cursor = of.map(str::to_string);
        while let Some(id) = cursor {
            if !seen.insert(id.clone()) {
                break;
            }
            if id == ancestor {
                return true;
            }
            cursor = self.parents.get(&id).cloned().flatten();
        }
        false
    }

    /// The assistant message that issued tool call `id`: the one on the path to `at`, else the latest.
    pub fn tool_call_owner(&self, id: &str, at: Option<Option<&str>>) -> Option<String> {
        let owners = self.tool_calls.get(id)?;
        at.and_then(|at| owners.iter().rev().find(|owner| self.is_ancestor(owner, at)).cloned()).or_else(|| owners.last().cloned())
    }

    pub fn has_tool_call(&self, id: &str) -> bool {
        self.tool_calls.contains_key(id)
    }

    /// A builder that keeps no records, to read a file of any length as a stream.
    pub fn streaming(context: DecodeContext<'a>) -> Self {
        Self { retain: false, ..Self::new(context) }
    }

    /// Observes a record, with `native` when given, and returns it; kept in `records` unless streaming.
    pub fn push_owned(&mut self, record: Map, native: Option<Map>) -> Map {
        let full = match native {
            Some(native) => Obj::new().spread(&record).set("native", Value::Object(native)).build(),
            None => record,
        };
        self.observe(&full);
        if self.retain {
            self.records.push(full.clone());
        }
        full
    }

    /// What the builder knows, as JSON, keys in UTF-16 order, as `TreeBuilder.state` writes it in TypeScript.
    pub fn state(&self) -> Value {
        let resolved = sorted(self.resolved.keys().collect())
            .into_iter()
            .map(|native| match &self.resolved[native] {
                Some(id) if id == native => Value::String(native.clone()),
                id => Value::Array(vec![Value::String(native.clone()), opt_value(id.as_deref())]),
            })
            .collect();
        let nodes = sorted(self.parents.keys().collect())
            .into_iter()
            .map(|id| {
                let kind = self.types.get(id).cloned().unwrap_or_default();
                Value::Array(vec![Value::String(id.clone()), opt_value(self.parents[id].as_deref()), Value::String(kind)])
            })
            .collect();
        let tool_calls = sorted(self.tool_calls.keys().collect())
            .into_iter()
            .map(|call| {
                let owners = self.tool_calls[call].iter().cloned().map(Value::String).collect();
                Value::Array(vec![Value::String(call.clone()), Value::Array(owners)])
            })
            .collect();
        Obj::new()
            .set("resolved", Value::Array(resolved))
            .set("nodes", Value::Array(nodes))
            .set("toolCalls", Value::Array(tool_calls))
            .set("last", opt_value(self.last.as_deref()))
            .value()
    }

    /// Picks up where the builder whose `state()` this is left off; `None` when `state` is not one.
    pub fn restore(&mut self, state: &Value) -> Option<()> {
        let nullable = |value: &Value| match value {
            Value::Null => Some(None),
            Value::String(s) => Some(Some(s.clone())),
            _ => None,
        };
        for entry in state.arr("resolved")? {
            match entry {
                Value::String(id) => {
                    self.resolved.insert(id.clone(), Some(id.clone()));
                }
                Value::Array(pair) if pair.len() == 2 => {
                    self.resolved.insert(pair[0].as_str()?.to_string(), nullable(&pair[1])?);
                }
                _ => return None,
            }
        }
        for node in state.arr("nodes")? {
            let node = node.as_array().filter(|n| n.len() == 3)?;
            let id = node[0].as_str()?.to_string();
            self.parents.insert(id.clone(), nullable(&node[1])?);
            self.types.insert(id, node[2].as_str()?.to_string());
        }
        for pair in state.arr("toolCalls")? {
            let pair = pair.as_array().filter(|p| p.len() == 2)?;
            let owners = pair[1].as_array()?.iter().map(|o| o.as_str().map(str::to_string)).collect::<Option<Vec<_>>>()?;
            self.tool_calls.insert(pair[0].as_str()?.to_string(), owners);
        }
        self.last = nullable(state.field("last")?)?;
        Some(())
    }

    /// Appends a record, with `native` when given.
    pub fn push(&mut self, record: Map, native: Option<Map>) -> &Map {
        let full = match native {
            Some(native) => Obj::new().spread(&record).set("native", Value::Object(native)).build(),
            None => record,
        };
        self.observe(&full);
        self.records.push(full);
        self.records.last().expect("just pushed")
    }

    pub fn take_id(&mut self, preferred: &str) -> String {
        self.context.ids.take(preferred)
    }

    pub fn is_known(&self, index: usize) -> bool {
        self.context.known.contains_key(&index)
    }

    /// The ATXF id a known unit stands for.
    pub fn known(&self, index: usize) -> Option<String> {
        self.context.known.get(&index).cloned().flatten()
    }
}
