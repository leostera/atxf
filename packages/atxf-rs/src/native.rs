//! Native passthrough (SPEC §11): source units and the framings that lay them out in a file.

use crate::json::{self, Get, Map, Obj, Value};
use crate::transcript::Transcript;

/// One record of a source file: its parsed value (`null` when the text is not JSON) and its exact text, including
/// the line terminator and any blank lines that follow.
#[derive(Clone, Debug, PartialEq)]
pub struct Unit {
    pub value: Value,
    pub raw: String,
}

/// How a format lays its records out in a file.
pub trait Framing: Sync {
    fn parse(&self, text: &str) -> Vec<Unit>;
    fn print(&self, units: &[Unit]) -> String;
    /// The text this framing writes for a fresh record. A unit whose raw text differs keeps it in `native.raw`.
    fn canonical(&self, value: &Value) -> String;
}

/// The text `JSON.stringify` gives a JSONL record.
pub fn jsonl_line(value: &Value) -> String {
    let mut line = json::stringify(value);
    line.push('\n');
    line
}

/// JSON Lines. Blank lines and a missing final newline stay in the raw text of the record before them; blank lines
/// before the first record stay in its raw text. A line that is not JSON becomes a unit with value `null`, so even
/// a damaged file round-trips.
pub struct Jsonl;

impl Framing for Jsonl {
    fn parse(&self, text: &str) -> Vec<Unit> {
        let mut units: Vec<Unit> = Vec::new();
        let mut leading = String::new();
        for line in text.split_inclusive('\n') {
            if json::trim(line).is_empty() {
                match units.last_mut() {
                    Some(last) => last.raw.push_str(line),
                    None => leading.push_str(line),
                }
                continue;
            }
            let value = json::parse(line).unwrap_or(Value::Null);
            units.push(Unit { value, raw: format!("{leading}{line}") });
            leading.clear();
        }
        if !leading.is_empty() {
            // A file of only blank lines: keep them on an empty unit so they survive.
            units.push(Unit { value: Value::Null, raw: leading });
        }
        units
    }

    fn print(&self, units: &[Unit]) -> String {
        units.iter().map(|u| u.raw.as_str()).collect()
    }

    fn canonical(&self, value: &Value) -> String {
        jsonl_line(value)
    }
}

/// A unit for a value written fresh, in the canonical JSONL layout.
pub fn fresh_unit(value: Value) -> Unit {
    let raw = jsonl_line(&value);
    Unit { value, raw }
}

/// A JSON document holding the records in one array, e.g. `{"info": {...}, "messages": [...]}`. The first unit is
/// the document without the array; each array element is a unit. A document in the canonical layout
/// (`JSON.stringify` with `indent`, the array key last, then `eol`) keeps no raw text; any other layout keeps the
/// whole text on the first unit.
pub struct JsonDocument {
    pub items: &'static str,
    pub indent: &'static str,
    pub eol: &'static str,
}

impl JsonDocument {
    fn build(&self, units: &[Unit]) -> Option<String> {
        let head = units.first()?.value.as_object()?;
        let items = Value::Array(units[1..].iter().map(|u| u.value.clone()).collect());
        let doc = Obj::new().spread(head).set(self.items, items).value();
        Some(format!("{}{}", json::stringify_pretty(&doc, self.indent), self.eol))
    }
}

impl Framing for JsonDocument {
    fn parse(&self, text: &str) -> Vec<Unit> {
        let Ok(doc) = json::parse(text) else {
            return vec![Unit { value: Value::Null, raw: text.to_string() }];
        };
        let Some(map) = doc.as_object().filter(|m| m.arr(self.items).is_some()) else {
            return vec![Unit { value: doc, raw: text.to_string() }];
        };
        let mut head = Map::new();
        for (key, value) in json::entries(map) {
            if key != self.items {
                head.insert(key.clone(), value.clone());
            }
        }
        let mut units = vec![Unit { value: Value::Object(head), raw: String::new() }];
        units.extend(map.arr(self.items).into_iter().flatten().map(|v| Unit { value: v.clone(), raw: String::new() }));
        if self.build(&units).as_deref() != Some(text) {
            units[0].raw = text.to_string();
        }
        units
    }

    fn print(&self, units: &[Unit]) -> String {
        match units.first() {
            None => String::new(),
            Some(first) if !first.raw.is_empty() => first.raw.clone(),
            Some(_) => self.build(units).unwrap_or_default(),
        }
    }

    fn canonical(&self, _value: &Value) -> String {
        String::new()
    }
}

/// `native` for a group of units. `raw` is present only when some unit's text is not its canonical text.
pub fn native_of(units: &[&Unit], source: &str, format: &str, framing: &dyn Framing) -> Map {
    let exact = units.iter().any(|u| u.raw != framing.canonical(&u.value));
    Obj::new()
        .set("source", source)
        .opt("format", (!format.is_empty()).then_some(format))
        .set("records", Value::Array(units.iter().map(|u| u.value.clone()).collect()))
        .opt("raw", exact.then(|| Value::Array(units.iter().map(|u| Value::String(u.raw.clone())).collect())))
        .build()
}

/// `native` for a record derived from the same units as the earlier record `of`.
pub fn native_of_shared(of: &str, source: &str, format: &str) -> Map {
    Obj::new()
        .set("source", source)
        .opt("format", (!format.is_empty()).then_some(format))
        .set("records", Value::Array(vec![]))
        .set("of", of)
        .build()
}

/// The units a `native` carries, rebuilding canonical text where it has no `raw`.
pub fn units_of_native(native: &Map, framing: &dyn Framing) -> Vec<Unit> {
    let raw = native.arr("raw");
    native
        .arr("records")
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(i, value)| {
            let text = raw.and_then(|r| r.get(i)).filter(|v| !v.is_null()).map(|v| match v {
                Value::String(s) => s.clone(),
                other => json::to_js_string(other),
            });
            Unit { value: value.clone(), raw: text.unwrap_or_else(|| framing.canonical(value)) }
        })
        .collect()
}

/// True when the transcript came entirely from `agent` and still carries all of its native records, so the source
/// file can be reproduced from passthrough alone.
pub fn is_pure_native(transcript: &Transcript, agent: &str) -> bool {
    let header = &transcript.header;
    if header.obj("source").and_then(|s| s.str("agent")) != Some(agent)
        || header.obj("fidelity").and_then(|f| f.str("native")) != Some("all")
    {
        return false;
    }
    if let Some(native) = header.field("native")
        && native.str("source") != Some(agent)
    {
        return false;
    }
    transcript.records.iter().all(|r| r.obj("native").and_then(|n| n.str("source")) == Some(agent))
}

/// The source units of a pure transcript, in file order: the header's first, then each record's.
pub fn native_units(transcript: &Transcript, framing: &dyn Framing) -> Vec<Unit> {
    let mut units = Vec::new();
    if let Some(native) = transcript.header.obj("native") {
        units.extend(units_of_native(native, framing));
    }
    for record in &transcript.records {
        if let Some(native) = record.obj("native") {
            units.extend(units_of_native(native, framing));
        }
    }
    units
}
