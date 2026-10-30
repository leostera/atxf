//! Transcripts: a header and records in file order (SPEC §1, §2).
//!
//! Records stay JSON objects. ATXF records carry `native` passthrough and `ext` fields of any shape, and a
//! converter must write back exactly what it read, so records are kept as ordered JSON rather than mapped into
//! structs; [`Record`] gives typed access to the fields every record has.

use std::fmt;

use crate::json::{self, Get, Map, Value};

/// A parsed transcript: the header and the remaining records in file order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Transcript {
    pub header: Map,
    pub records: Vec<Map>,
}

/// An error reading or converting a transcript.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

/// Record types that are tree nodes (SPEC §3); the rest are annotations.
pub const TREE_TYPES: [&str; 12] = [
    "message",
    "context",
    "settings",
    "compaction",
    "context_edit",
    "branch_summary",
    "turn",
    "tool_status",
    "usage",
    "checkpoint",
    "agent_link",
    "custom",
];

/// The fields every record has.
pub trait Record {
    fn kind(&self) -> &str;
    fn id(&self) -> &str;
    fn time(&self) -> &str;
    /// The parent of a tree record; `None` for a root or an annotation.
    fn parent_id(&self) -> Option<&str>;
    fn is_tree(&self) -> bool;
}

impl Record for Map {
    fn kind(&self) -> &str {
        self.str("type").unwrap_or("")
    }
    fn id(&self) -> &str {
        self.str("id").unwrap_or("")
    }
    fn time(&self) -> &str {
        self.str("time").unwrap_or("")
    }
    fn parent_id(&self) -> Option<&str> {
        self.str("parentId")
    }
    fn is_tree(&self) -> bool {
        TREE_TYPES.contains(&self.kind())
    }
}

impl Transcript {
    /// A transcript from its JSON form, `{header, records}`, as converters carry it.
    pub fn from_value(value: &Value) -> Result<Self, Error> {
        let header = value.obj("header").ok_or_else(|| Error::new("a carried transcript needs a `header` object"))?;
        let records = value.arr("records").ok_or_else(|| Error::new("a carried transcript needs a `records` array"))?;
        let records = records
            .iter()
            .map(|r| r.as_object().cloned().ok_or_else(|| Error::new("every carried record must be an object")))
            .collect::<Result<_, _>>()?;
        Ok(Self { header: header.clone(), records })
    }

    /// The JSON form, `{header, records}`.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("header".into(), Value::Object(self.header.clone()));
        map.insert("records".into(), Value::Array(self.records.iter().cloned().map(Value::Object).collect()));
        Value::Object(map)
    }

    /// The header's `id`.
    pub fn id(&self) -> &str {
        self.header.str("id").unwrap_or("")
    }
}

/// Splits JSONL text into parsed values, skipping blank lines.
pub fn parse_jsonl(text: &str) -> Result<Vec<Value>, Error> {
    let mut values = Vec::new();
    for (index, line) in text.split('\n').enumerate() {
        if json::trim(line).is_empty() {
            continue;
        }
        values.push(json::parse(line).map_err(|e| Error::new(format!("line {}: invalid JSON: {e}", index + 1)))?);
    }
    Ok(values)
}

pub fn to_jsonl(values: &[Value]) -> String {
    let mut out = String::new();
    for value in values {
        out.push_str(&json::stringify(value));
        out.push('\n');
    }
    out
}

/// Parses an ATXF transcript. Structural validation is [`crate::validate_transcript`]'s job; this only checks the
/// header.
pub fn parse_transcript(text: &str) -> Result<Transcript, Error> {
    let mut values = parse_jsonl(text)?.into_iter();
    let header = match values.next() {
        Some(Value::Object(header)) if header.is("type", "transcript") => header,
        _ => return Err(Error::new("the first record of an ATXF transcript must be `transcript`")),
    };
    let records = values
        .enumerate()
        .map(|(i, v)| match v {
            Value::Object(map) => Ok(map),
            _ => Err(Error::new(format!("record {}: not an object", i + 2))),
        })
        .collect::<Result<_, _>>()?;
    Ok(Transcript { header, records })
}

pub fn serialize_transcript(transcript: &Transcript) -> String {
    let mut out = json::stringify(&Value::Object(transcript.header.clone()));
    out.push('\n');
    for record in &transcript.records {
        out.push_str(&json::stringify(&Value::Object(record.clone())));
        out.push('\n');
    }
    out
}
