//! Validation: each line against the JSON Schema, then the cross-record invariants of SPEC.md that a per-line
//! schema cannot express, then hashes and seals.
//!
//! Formats are checked as ajv-formats checks them in the TypeScript implementation, so both accept the same
//! transcripts. Schema error messages are the validator's own and differ in wording.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;

use crate::integrity::verify_integrity;
use crate::json::{self, Get, Map, Value};
use crate::transcript::{Record, TREE_TYPES, Transcript};

/// The ATXF v0.1 record schema.
pub const SCHEMA: &str = include_str!("../schema/v0.1/atxf.schema.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warning => "warning",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub severity: Severity,
    /// 1-based line number in the JSONL input; 0 for whole-file problems.
    pub line: usize,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationResult {
    pub ok: bool,
    pub diagnostics: Vec<Diagnostic>,
}

fn is_js_space(c: char) -> bool {
    json::trim(&c.to_string()).is_empty()
}

/// ajv-formats `date-time` (full mode): an RFC 3339 date, `t`, `T` or whitespace, and a time with a time zone.
fn date_time(s: &str) -> bool {
    let parts: Vec<&str> = s.split(|c: char| c == 't' || c == 'T' || is_js_space(c)).collect();
    parts.len() == 2 && date(parts[0]) && time(parts[1])
}

fn ascii_digits(s: &str, n: usize) -> Option<u32> {
    (s.len() == n && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok())?
}

fn date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let (Some(year), Some(month), Some(day)) = (ascii_digits(&s[0..4], 4), ascii_digits(&s[5..7], 2), ascii_digits(&s[8..10], 2)) else {
        return false;
    };
    const DAYS: [u32; 13] = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    (1..=12).contains(&month) && day >= 1 && day <= if month == 2 && leap { 29 } else { DAYS[month as usize] }
}

fn time(s: &str) -> bool {
    static TIME: OnceLock<Regex> = OnceLock::new();
    let re = TIME.get_or_init(|| {
        Regex::new(r"(?i-u)^([0-9][0-9]):([0-9][0-9]):([0-9][0-9](?:\.[0-9]+)?)(z|([+-])([0-9][0-9])(?::?([0-9][0-9]))?)?$")
            .expect("valid regex")
    });
    let Some(m) = re.captures(s) else { return false };
    let num = |i: usize| m.get(i).map_or(0.0, |g| g.as_str().parse::<f64>().unwrap_or(f64::NAN));
    let (hr, min, sec) = (num(1), num(2), num(3));
    let tz_sign = if m.get(5).map(|g| g.as_str()) == Some("-") { -1.0 } else { 1.0 };
    let (tz_h, tz_m) = (num(6), num(7));
    if tz_h > 23.0 || tz_m > 59.0 || m.get(4).is_none() {
        return false;
    }
    if hr <= 23.0 && min <= 59.0 && sec < 60.0 {
        return true;
    }
    // A leap second.
    let utc_min = min - tz_m * tz_sign;
    let utc_hr = hr - tz_h * tz_sign - if utc_min < 0.0 { 1.0 } else { 0.0 };
    (utc_hr == 23.0 || utc_hr == -1.0) && (utc_min == 59.0 || utc_min == -1.0) && sec < 61.0
}

/// ajv-formats `uri-reference` (full mode).
fn uri_reference(s: &str) -> bool {
    static URI: OnceLock<Regex> = OnceLock::new();
    URI.get_or_init(|| {
        let pattern = r#"^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$"#;
        Regex::new(&format!("(?i-u){}", pattern.replace(r"\d", "[0-9]"))).expect("valid regex")
    })
    .is_match(s)
}

fn validator() -> &'static jsonschema::Validator {
    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    VALIDATOR.get_or_init(|| {
        let schema: Value = serde_json::from_str(SCHEMA).expect("the bundled schema is JSON");
        jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .should_validate_formats(true)
            .with_format("date-time", date_time)
            .with_format("uri-reference", uri_reference)
            .build(&schema)
            .expect("the bundled schema compiles")
    })
}

/// Validates one ATXF transcript (JSONL text).
pub fn validate_transcript(text: &str) -> ValidationResult {
    let mut diagnostics = Vec::new();
    let mut records: Vec<(usize, Value)> = Vec::new();
    for (index, raw) in text.split('\n').enumerate() {
        if json::trim(raw).is_empty() {
            continue;
        }
        match json::parse(raw) {
            Ok(value) => records.push((index + 1, value)),
            Err(e) => diagnostics.push(Diagnostic { severity: Severity::Error, line: index + 1, message: format!("invalid JSON: {e}") }),
        }
    }
    if records.is_empty() {
        diagnostics.push(Diagnostic { severity: Severity::Error, line: 0, message: "transcript is empty".into() });
        return finish(diagnostics);
    }
    for (line, record) in &records {
        if let Some(error) = validator().iter_errors(record).next() {
            let path = error.instance_path().to_string();
            let path = if path.is_empty() { "/".to_string() } else { path };
            diagnostics.push(Diagnostic { severity: Severity::Error, line: *line, message: format!("schema: {path} {error}") });
        }
    }
    if !diagnostics.is_empty() {
        return finish(diagnostics);
    }
    let maps: Vec<(usize, Map)> = records.into_iter().map(|(l, v)| (l, v.as_object().cloned().unwrap_or_default())).collect();
    check_references(&maps, &mut diagnostics);
    if diagnostics.iter().any(|d| d.severity == Severity::Error) {
        return finish(diagnostics);
    }
    check_integrity(&maps, &mut diagnostics);
    finish(diagnostics)
}

fn finish(diagnostics: Vec<Diagnostic>) -> ValidationResult {
    ValidationResult { ok: !diagnostics.iter().any(|d| d.severity == Severity::Error), diagnostics }
}

fn check_integrity(records: &[(usize, Map)], diagnostics: &mut Vec<Diagnostic>) {
    let (header_line, header) = &records[0];
    let rest = &records[1..];
    if header.field("integrity").is_none_or(|v| !json::truthy(v)) {
        for (line, record) in rest {
            if record.field("hash").is_some() {
                diagnostics.push(Diagnostic {
                    severity: Severity::Warning,
                    line: *line,
                    message: "record has a `hash` but the header does not declare `integrity`; it is not checked".into(),
                });
            }
        }
    }
    let transcript = Transcript { header: header.clone(), records: rest.iter().map(|(_, r)| r.clone()).collect() };
    for problem in verify_integrity(&transcript) {
        let line = problem.index.map_or(*header_line, |i| rest[i].0);
        diagnostics.push(Diagnostic { severity: Severity::Error, line, message: format!("integrity: {}", problem.message) });
    }
}

fn check_references(records: &[(usize, Map)], diagnostics: &mut Vec<Diagnostic>) {
    let push_error =
        |out: &mut Vec<Diagnostic>, line: usize, message: String| out.push(Diagnostic { severity: Severity::Error, line, message });
    let warn =
        |out: &mut Vec<Diagnostic>, line: usize, message: String| out.push(Diagnostic { severity: Severity::Warning, line, message });
    let require_node = |out: &mut Vec<Diagnostic>, nodes: &HashMap<String, String>, line: usize, field: &str, id: Option<&Value>| {
        if let Some(Value::String(id)) = id
            && !nodes.contains_key(id)
        {
            push_error(out, line, format!("{field} `{id}` does not reference an earlier tree record"));
        }
    };
    let ordered = diagnostics;
    let (header_line, header) = &records[0];
    if header.kind() != "transcript" {
        push_error(ordered, *header_line, "first record must be `transcript`".into());
    }
    let mut parents: HashMap<String, Option<String>> = HashMap::new();
    let mut nodes: HashMap<String, String> = HashMap::new();
    let mut ids: HashSet<String> = HashSet::new();
    // Tool call id → the assistant messages holding it. Ids are unique along a path, not across branches (SPEC §3).
    let mut tool_call_owner: HashMap<String, Vec<String>> = HashMap::new();

    let ancestors = |parents: &HashMap<String, Option<String>>, id: Option<&str>| -> HashSet<String> {
        let mut seen = HashSet::new();
        let mut cursor = id.map(str::to_string);
        while let Some(c) = cursor {
            if !seen.insert(c.clone()) {
                break;
            }
            cursor = parents.get(&c).cloned().flatten();
        }
        seen
    };

    for (line, record) in &records[1..] {
        let line = *line;
        if record.kind() == "transcript" {
            push_error(ordered, line, "`transcript` header must appear exactly once, on the first line".into());
            continue;
        }
        let id = record.field("id").map(json::to_js_string).unwrap_or_else(|| "undefined".into());
        if !ids.insert(id.clone()) {
            push_error(ordered, line, format!("duplicate id `{id}`"));
        }
        if TREE_TYPES.contains(&record.kind()) {
            require_node(ordered, &nodes, line, "parentId", record.field("parentId"));
            parents.insert(id.clone(), record.str("parentId").map(str::to_string));
            nodes.insert(id.clone(), record.kind().to_string());
        }
        match record.kind() {
            "message" => {
                if record.is("role", "assistant") {
                    for block in record.arr("content").into_iter().flatten() {
                        if !block.is("type", "tool_call") {
                            continue;
                        }
                        let call = block.field("id").map(json::to_js_string).unwrap_or_else(|| "undefined".into());
                        let owners = tool_call_owner.entry(call.clone()).or_default();
                        let path = ancestors(&parents, record.parent_id());
                        if owners.iter().any(|o| *o == id || path.contains(o)) {
                            push_error(ordered, line, format!("duplicate tool_call id `{call}` on one path"));
                        }
                        owners.push(id.clone());
                    }
                }
                if record.is("role", "tool") {
                    let call = record.field("toolCallId").map(json::to_js_string).unwrap_or_else(|| "undefined".into());
                    match tool_call_owner.get(&call) {
                        None => warn(ordered, line, format!("tool result references unknown toolCallId `{call}`")),
                        Some(owners) => {
                            let path = ancestors(&parents, record.parent_id());
                            if !owners.iter().any(|o| path.contains(o)) {
                                push_error(ordered, line, format!("tool result `{call}` is not on the same branch as its call"));
                            }
                        }
                    }
                }
            }
            "compaction" => {
                if let (true, Some(kept)) = (record.is("strategy", "summary"), record.str("firstKeptId")) {
                    require_node(ordered, &nodes, line, "firstKeptId", record.field("firstKeptId"));
                    if !ancestors(&parents, record.parent_id()).contains(kept) {
                        push_error(ordered, line, format!("firstKeptId `{kept}` must be an ancestor of the compaction"));
                    }
                }
            }
            "context_edit" => {
                require_node(ordered, &nodes, line, "targetId", record.field("targetId"));
                if record.str("targetId").and_then(|t| nodes.get(t)).map(String::as_str) != Some("message") {
                    push_error(ordered, line, "context_edit targetId must reference a `message`".into());
                }
            }
            "branch_summary" => require_node(ordered, &nodes, line, "fromId", record.field("fromId")),
            "tool_status" => {
                let call = record.field("toolCallId").map(json::to_js_string).unwrap_or_else(|| "undefined".into());
                if !tool_call_owner.contains_key(&call) {
                    warn(ordered, line, format!("tool_status references unknown toolCallId `{call}`"));
                }
            }
            "leaf" => {
                require_node(ordered, &nodes, line, "targetId", record.field("targetId"));
                require_node(ordered, &nodes, line, "restoreCheckpointId", record.field("restoreCheckpointId"));
                if let Some(restore) = record.field("restoreCheckpointId").filter(|v| json::truthy(v))
                    && restore.as_str().and_then(|r| nodes.get(r)).map(String::as_str) != Some("checkpoint")
                {
                    push_error(ordered, line, "restoreCheckpointId must reference a `checkpoint`".into());
                }
            }
            "label" => require_node(ordered, &nodes, line, "targetId", record.field("targetId")),
            _ => {}
        }
    }
}
