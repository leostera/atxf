//! Pi session files (`~/.pi/agent/sessions/**.jsonl`), session version 3, as documented in Pi's
//! `docs/session-format.md` and `docs/message-types.md`.

use std::collections::HashMap;

use super::{Node, obj_or_empty, opt_str, or_else, replay_data, text_blocks};
use crate::codec::{Converter, DecodeContext, Decoded, Encoded, FormatSpec, IdAllocator, TreeBuilder, TreeUnit, carried_value, mark_id};
use crate::context::{BuildContextOptions, build_context};
use crate::json::{self, Get, Map, Obj, Value, amount, count, entries, number, s, to_js_string};
use crate::native::{Framing, Jsonl, Unit, native_of};
use crate::patch::{apply, diff};
use crate::time::{EPOCH, iso_time, millis_from_iso};
use crate::transcript::{Record, Transcript};

pub struct Pi;

const AGENT: &str = "pi";
const FORMAT: &str = "pi/session-jsonl";
/// Custom-record namespace for a Pi entry with no ATXF form: `data` is the whole entry.
const ENTRY: &str = "pi.entry";
/// Custom-record namespace for a line that is not JSON: `data.text` is the line.
const LINE: &str = "pi.line";
/// The Pi custom type of an entry carrying an ATXF record Pi has no entry for: `data` is the record.
const CARRIED: &str = "atxf.record";
/// Envelope fields of a record, besides the fields its type gives it.
const ENVELOPE: [&str; 7] = ["type", "id", "parentId", "time", "ext", "native", "hash"];

fn native(unit: &Unit) -> Map {
    native_of(&[unit], AGENT, FORMAT, &Jsonl)
}

impl FormatSpec for Pi {
    const AGENT: &'static str = AGENT;
    const FORMAT: &'static str = FORMAT;

    fn framing(&self) -> &dyn Framing {
        &Jsonl
    }

    fn decode(&self, units: &[Unit], context: DecodeContext<'_>) -> Decoded {
        let mut tree = TreeBuilder::new(context);
        let mut start = 0;
        let header = match units.first().map(|u| &u.value) {
            Some(Value::Object(first)) if first.is("type", "session") && !tree.is_known(0) => {
                start = 1;
                let (session, reverse) = match unpatched(&units[0].value) {
                    Some((session, reverse)) => (session, Some(reverse)),
                    None => (units[0].value.clone(), None),
                };
                let header = patched(session_header(&obj_or_empty(Some(&session))), &session, session_entry);
                let header = reversed(header, reverse.as_ref());
                Obj::new().spread(&header).set("native", Value::Object(native(&units[0]))).build()
            }
            // A file without a session line: the header says so, and the whole-tree writer writes none.
            _ => {
                Obj::new().spread(&session_header(&Map::new())).set("ext", Obj::new().set(AGENT, Obj::new().set("session", false))).build()
            }
        };
        let mut has_context = tree.context.base.is_some_and(|b| b.records.iter().any(|r| r.kind() == "context"));
        let fallback_time = header.str("time").unwrap_or(EPOCH).to_string();

        for (index, unit) in units.iter().enumerate().skip(start) {
            let entry = &unit.value;
            if tree.is_known(index) {
                if let Some(id @ Value::String(_)) = entry.field("id") {
                    let target = tree.known(index).or_else(|| tree.parent_of(entry.field("parentId")));
                    tree.alias(Some(id), target);
                }
                continue;
            }
            let stripped = unpatched(entry).map(|(value, reverse)| (Unit { value, raw: unit.raw.clone() }, reverse));
            let (read_from, reverse) = match &stripped {
                Some((unit, reverse)) => (unit, Some(reverse)),
                None => (unit, None),
            };
            let read = entry_record(read_from, index, &mut tree, &fallback_time, has_context);
            let last = tree.last.clone();
            let record = if is_line(&read) { read } else { patched(read, &read_from.value, |r| pi_entry(r, last.as_deref())) };
            let record = reversed(record, reverse);
            if record.kind() == "context" {
                has_context = true;
            }
            tree.push(record, Some(native(unit)));
        }
        Decoded { header, records: tree.records }
    }

    fn encode(&self, transcript: &Transcript, _session_id: Option<&str>) -> Vec<Encoded> {
        encode(transcript)
    }

    fn encode_tree(&self, transcript: &Transcript) -> Option<Vec<TreeUnit>> {
        Some(encode_tree(transcript))
    }

    fn mark(&self, value: Value, source: Option<&str>) -> Value {
        Obj::new().spread(&obj_or_empty(Some(&value))).set("atxf", Obj::new().set("id", opt_str(source))).value()
    }

    fn mark_of(&self, value: &Value) -> Option<Option<String>> {
        mark_id(value.obj("atxf"))
    }

    fn attach(&self, values: Vec<Value>, transcript: &Transcript) -> Vec<Value> {
        let mut values = values.into_iter();
        let header = obj_or_empty(values.next().as_ref());
        let atxf = Obj::new().spread(&obj_or_empty(header.field("atxf"))).set("transcript", carried_value(transcript));
        let mut out = vec![Obj::new().spread(&header).set("atxf", atxf).value()];
        out.extend(values);
        out
    }

    fn detach(&self, units: &mut Vec<Unit>) -> Option<Value> {
        detach_from_atxf_key(units)
    }
}

/// Finds a unit whose `atxf` key carries the transcript, and returns the transcript and the units with the mark
/// left in place. Shared by the formats that carry the transcript on a header line (Pi, Gemini CLI).
pub(super) fn detach_from_atxf_key(units: &mut [Unit]) -> Option<Value> {
    let index = units.iter().position(|u| u.value.obj("atxf").and_then(|a| a.obj("transcript")).is_some())?;
    units[index].value.get_mut("atxf")?.as_object_mut()?.shift_remove("transcript")
}

/// `record` with what `value`, the native entry it was read from, holds beyond it: the patch from the entry `write`
/// gives for the record back to `value` (SPEC §11.2), in `ext.pi.patch`.
fn patched(mut record: Map, value: &Value, write: impl FnOnce(&Map) -> Value) -> Map {
    let patch = diff(value, &write(&record));
    if patch.is_empty() {
        return record;
    }
    // In place, as `{...record, ext: {...record.ext, pi: {patch}}}` orders keys: an existing key keeps its place.
    let ext = record.entry("ext").or_insert_with(|| Value::Object(Map::new()));
    if !ext.is_object() {
        *ext = Value::Object(Map::new());
    }
    if let Value::Object(ext) = ext {
        ext.insert(AGENT.to_string(), Obj::new().set("patch", Value::Array(patch)).value());
    }
    record
}

/// An entry the whole-tree writer wrote, without what it added: `atxf.patch`, the patch that turns the record read
/// from the entry into the record it was written for, when Pi cannot hold all of it (SPEC §11.2).
fn unpatched(entry: &Value) -> Option<(Value, Vec<Value>)> {
    let atxf = entry.obj("atxf").filter(|atxf| atxf.len() == 1)?;
    let patch = atxf.arr("patch")?.clone();
    let mut rest = entry.as_object()?.clone();
    rest.shift_remove("atxf");
    Some((Value::Object(rest), patch))
}

/// `record` with the reverse patch applied; unpatched when it does not apply.
fn reversed(record: Map, reverse: Option<&Vec<Value>>) -> Map {
    let Some(reverse) = reverse else { return record };
    let record = Value::Object(record);
    match (apply(&record, reverse), record) {
        (Some(Value::Object(patched)), _) | (_, Value::Object(patched)) => patched,
        _ => Map::new(),
    }
}

fn is_line(record: &Map) -> bool {
    record.is("type", "custom") && record.is("namespace", LINE)
}

fn session_header(session: &Map) -> Map {
    let id = session.nonempty("id").unwrap_or("pi-session");
    Obj::new()
        .set("type", "transcript")
        .set("atxf", crate::ATXF_VERSION)
        .set("id", id)
        .set("time", iso_time(session.field("timestamp"), EPOCH))
        .set(
            "source",
            Obj::new()
                .set("agent", AGENT)
                .set("format", FORMAT)
                .opt("version", session.field("version").map(to_js_string))
                .opt("sessionId", session.str("id")),
        )
        .opt("workspace", session.str("cwd").map(|cwd| Obj::new().set("cwd", cwd)))
        .opt("parent", session.nonempty("parentSession").map(|p| Obj::new().set("transcriptId", p).set("uri", p).set("relation", "fork")))
        .set(
            "fidelity",
            Obj::new().set("topology", "tree").set("instructions", "full").set("tools", "full").set("native", "all").set("ids", "stable"),
        )
        .build()
}

enum Body {
    Message(Map),
    Context,
}

fn entry_record(unit: &Unit, index: usize, tree: &mut TreeBuilder<'_>, fallback_time: &str, has_context: bool) -> Map {
    let entry = &unit.value;
    let e = obj_or_empty(Some(entry));
    let preferred = e.nonempty("id").map_or_else(|| format!("pi-line-{}", index + 1), str::to_string);
    let id = tree.take_id(&preferred);
    let parent_id = tree.parent_of(e.field("parentId"));
    let time = iso_time(e.field("timestamp"), fallback_time);
    let node = Node { id: id.clone(), parent_id: parent_id.clone(), time: time.clone() };
    let native_id = e.field("id").cloned();
    // An entry with no ATXF form is kept whole, as a custom record: never refused, never dropped (SPEC §11.2).
    let custom = |tree: &mut TreeBuilder<'_>| {
        tree.alias(native_id.as_ref(), Some(id.clone()));
        if entry.is_null() && json::trim(&unit.raw) != "null" {
            let text = unit.raw.strip_suffix('\n').unwrap_or(&unit.raw);
            return node.record("custom").set("namespace", LINE).set("name", "line").set("data", Obj::new().set("text", text)).build();
        }
        node.record("custom").set("namespace", ENTRY).set("name", e.nonempty("type").unwrap_or("entry")).set("data", entry.clone()).build()
    };
    let as_tree = |tree: &mut TreeBuilder<'_>, record: Map| {
        tree.alias(native_id.as_ref(), Some(id.clone()));
        record
    };

    if !entry.is_object() {
        return custom(tree);
    }
    match e.str("type") {
        Some("message") => match message_body(e.field("message"), tree, &time) {
            Some(Body::Context) => {
                let message = obj_or_empty(e.field("message"));
                as_tree(tree, context_record(&node, &message, has_context))
            }
            Some(Body::Message(body)) => as_tree(tree, node.record("message").spread(&body).build()),
            None => custom(tree),
        },
        Some("model_change") => match (e.str("provider"), e.str("modelId")) {
            (Some(provider), Some(model)) => {
                as_tree(tree, node.record("settings").set("model", Obj::new().set("provider", provider).set("id", model)).build())
            }
            _ => custom(tree),
        },
        Some("thinking_level_change") => match e.str("thinkingLevel") {
            Some(level) => as_tree(tree, node.record("settings").set("reasoningEffort", level).build()),
            None => custom(tree),
        },
        Some("usage") => match usage_of(e.field("usage")) {
            Some(usage) => {
                let model = match (e.str("provider"), e.str("model")) {
                    (Some(p), Some(m)) => Some(Obj::new().set("provider", p).set("id", m)),
                    _ => None,
                };
                as_tree(
                    tree,
                    node.record("usage").set("kind", e.str("kind").unwrap_or("unknown")).opt("model", model).set("usage", usage).build(),
                )
            }
            None => custom(tree),
        },
        Some("compaction") => {
            let Some(summary) = e.str("summary") else { return custom(tree) };
            let mut first_kept = tree.resolve(e.field("firstKeptEntryId"));
            if let Some(kept) = &first_kept
                && !tree.is_ancestor(kept, parent_id.as_deref())
            {
                first_kept = None;
            }
            let snapshot = e.obj("systemMessage").map(prompt_of).map(|p| {
                Obj::new()
                    .set("instructions", Value::Array(p.instructions))
                    .set("tools", Value::Array(p.tools.into_iter().map(Value::Object).collect()))
            });
            let tokens_before = count(e.field("tokensBefore")).map(number);
            as_tree(
                tree,
                node.record("compaction")
                    .set("strategy", "summary")
                    .set("summary", summary)
                    .set("firstKeptId", opt_str(first_kept.as_deref()))
                    .opt("snapshot", snapshot)
                    .opt("tokensBefore", tokens_before)
                    .opt("files", files_of(e.field("details")))
                    .opt("usage", usage_of(e.field("usage")))
                    .build(),
            )
        }
        Some("context_edit") => {
            let target = tree.resolve(e.field("targetId"));
            let Some(target) = target.filter(|t| tree.type_of(t) == Some("message")) else { return custom(tree) };
            let replacement = match e.field("replacement") {
                Some(Value::Null) => Some(Value::Null),
                other => user_content(other),
            };
            match replacement {
                Some(replacement) => {
                    as_tree(tree, node.record("context_edit").set("targetId", target).set("replacement", replacement).build())
                }
                None => custom(tree),
            }
        }
        Some("branch_summary") => match (tree.resolve(e.field("fromId")), e.str("summary")) {
            (Some(from), Some(summary)) => as_tree(
                tree,
                node.record("branch_summary").set("fromId", from).set("summary", summary).opt("usage", usage_of(e.field("usage"))).build(),
            ),
            _ => custom(tree),
        },
        Some("custom") => {
            tree.alias(native_id.as_ref(), Some(id.clone()));
            if let Some(carried) = carried_record(&e, &node) {
                return carried;
            }
            node.record("custom")
                .set("namespace", AGENT)
                .set("name", e.nonempty("customType").unwrap_or("custom"))
                .opt("data", e.field("data").cloned())
                .build()
        }
        Some("custom_message") => match user_content(e.field("content")) {
            Some(content) => as_tree(
                tree,
                node.record("message")
                    .set("role", "user")
                    .set("content", content)
                    .set("origin", Obj::new().set("kind", "extension").opt("name", e.nonempty("customType")))
                    .opt("display", e.bool("display"))
                    .build(),
            ),
            None => custom(tree),
        },
        Some("label") => match tree.resolve(e.field("targetId")) {
            Some(target) => {
                tree.alias(native_id.as_ref(), parent_id.clone());
                Obj::new()
                    .set("type", "label")
                    .set("id", id.as_str())
                    .set("time", time.as_str())
                    .set("targetId", target)
                    .set("label", opt_str(e.str("label")))
                    .build()
            }
            None => custom(tree),
        },
        Some("session_info") => match e.str("name") {
            Some(name) => {
                tree.alias(native_id.as_ref(), parent_id.clone());
                Obj::new().set("type", "metadata").set("id", id.as_str()).set("time", time.as_str()).set("title", name).build()
            }
            None => custom(tree),
        },
        _ => custom(tree),
    }
}

/// The ATXF record a Pi custom entry written by `encode_tree` carries, with the entry's id, parent and time.
fn carried_record(e: &Map, node: &Node) -> Option<Map> {
    let data = e.obj("data").filter(|_| e.is("customType", CARRIED))?;
    let kind = data.str("type")?;
    let rest: Map = json::entries(data)
        .filter(|(k, _)| !["type", "parentId", "id", "time"].contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let record = Obj::new().set("type", kind).set("id", node.id.as_str());
    let record = if data.contains_key("parentId") { record.set("parentId", opt_str(node.parent_id.as_deref())) } else { record };
    Some(record.set("time", node.time.as_str()).spread(&rest).build())
}

fn replay(base: &Obj, kind: &str, data: Option<&Value>) -> Option<Value> {
    match data {
        Some(Value::String(d)) if !d.is_empty() => Some(Value::Array(vec![base.clone().set("kind", kind).set("data", d.as_str()).value()])),
        _ => None,
    }
}

/// A Pi message as an ATXF message body; `Context` for a system message; `None` when it has no portable form.
fn message_body(message: Option<&Value>, tree: &TreeBuilder<'_>, time: &str) -> Option<Body> {
    let message = message?.as_object()?;
    // Pi's message timestamp is when the message began (the request, for an assistant message); the entry's is when
    // it was written. ATXF keeps the first only when it differs.
    let began = iso_time(message.field("timestamp"), time);
    let start_time = (millis_from_iso(&began) != millis_from_iso(time)).then_some(began);
    match message.str("role")? {
        "system" => Some(Body::Context),
        "user" => Some(Body::Message(
            Obj::new().set("role", "user").set("content", user_content(message.field("content"))?).opt("startTime", start_time).build(),
        )),
        "assistant" => {
            let blocks = message.arr("content")?;
            let model = match (message.str("provider"), message.str("model")) {
                (Some(provider), Some(id)) => {
                    Some(Obj::new().set("provider", provider).set("id", id).opt("api", message.str("api")).build())
                }
                _ => None,
            };
            let replay_base = Obj::new()
                .set("provider", model.as_ref().and_then(|m| m.str("provider")).unwrap_or("unknown"))
                .opt("api", model.as_ref().and_then(|m| m.str("api")))
                .opt("model", model.as_ref().and_then(|m| m.str("id")));
            let mut content = Vec::new();
            for block in blocks {
                let Some(block) = block.as_object() else { continue };
                match block.str("type") {
                    Some("text") if block.str("text").is_some() => content.push(
                        Obj::new()
                            .set("type", "text")
                            .set("text", block["text"].clone())
                            .opt("replay", replay(&replay_base, "text_signature", block.field("textSignature")))
                            .value(),
                    ),
                    Some("thinking") if block.str("thinking").is_some() => content.push(
                        Obj::new()
                            .set("type", "reasoning")
                            .set("text", block["thinking"].clone())
                            .opt("redacted", (block.bool("redacted") == Some(true)).then_some(true))
                            .opt("replay", replay(&replay_base, "signature", block.field("thinkingSignature")))
                            .value(),
                    ),
                    Some("toolCall") if block.str("id").is_some() && block.str("name").is_some() => {
                        let id = block.str("id").unwrap_or_default();
                        if tree.has_tool_call(id) {
                            continue; // A repeat of a call already in the tree stays in native only.
                        }
                        content.push(
                            Obj::new()
                                .set("type", "tool_call")
                                .set("id", id)
                                .set("name", block["name"].clone())
                                .opt("namespace", block.str("namespace"))
                                .set("arguments", block.obj("arguments").cloned().unwrap_or_default())
                                .opt("replay", replay(&replay_base, "thought_signature", block.field("thoughtSignature")))
                                .value(),
                        );
                    }
                    Some("image") if block.str("mimeType").is_some() => content.push(
                        Obj::new().set("type", "image").set("mediaType", block["mimeType"].clone()).opt("data", block.str("data")).value(),
                    ),
                    _ => {}
                }
            }
            let stop = stop_of(message.field("stopReason"));
            let raw_stop = match (message.str("rawStopReason"), message.str("stopReason")) {
                (Some(raw), _) => Some(raw),
                (None, Some(reason)) if stop == Some("other") => Some(reason),
                _ => None,
            };
            Some(Body::Message(
                Obj::new()
                    .set("role", "assistant")
                    .set("content", Value::Array(content))
                    .opt("model", model)
                    .opt("usage", usage_of(message.field("usage")))
                    .opt("stop", stop)
                    .opt("rawStop", raw_stop)
                    .opt("responseId", message.str("responseId"))
                    .opt("responseModel", message.str("responseModel"))
                    .opt("reasoningEffort", message.str("thinkingLevel"))
                    .opt("providerReasoningEffort", message.str("providerThinkingLevel"))
                    .opt("error", message.str("errorMessage").map(|m| Obj::new().set("message", m)))
                    .opt("startTime", start_time)
                    .opt("durationMs", duration(message.field("durationMs")))
                    .build(),
            ))
        }
        "toolResult" => {
            let call = message.str("toolCallId")?;
            let content = user_content(message.field("content"))?;
            Some(Body::Message(
                Obj::new()
                    .set("role", "tool")
                    .set("toolCallId", call)
                    .opt("toolName", message.str("toolName"))
                    .set("content", content)
                    .opt("isError", message.bool("isError"))
                    .opt("details", message.obj("details").cloned())
                    .opt("nestedCalls", nested_calls_of(message.field("nestedCalls")))
                    .opt("startTime", start_time)
                    .opt("durationMs", duration(message.field("durationMs")))
                    .build(),
            ))
        }
        "custom" => {
            let content = user_content(message.field("content"))?;
            Some(Body::Message(
                Obj::new()
                    .set("role", "user")
                    .set("content", content)
                    .set("origin", Obj::new().set("kind", "extension").opt("name", message.nonempty("customType")))
                    .opt("display", message.bool("display"))
                    .build(),
            ))
        }
        "bashExecution" => {
            if message.bool("excludeFromContext") == Some(true) {
                return None;
            }
            let command = message.str("command")?;
            let output = message.str("output").unwrap_or("");
            Some(Body::Message(
                Obj::new()
                    .set("role", "user")
                    .set("content", format!("$ {command}\n{output}"))
                    .set("origin", Obj::new().set("kind", "command").set("name", "bash"))
                    .build(),
            ))
        }
        _ => None,
    }
}

fn context_record(node: &Node, message: &Map, has_context: bool) -> Map {
    let prompt = prompt_of(message);
    node.record("context")
        .set("mode", if has_context { "patch" } else { "replace" })
        .opt("instructions", (!prompt.instructions.is_empty()).then(|| Value::Array(prompt.instructions)))
        .opt("toolsAdded", (!prompt.tools.is_empty()).then(|| Value::Array(prompt.tools.into_iter().map(Value::Object).collect())))
        .opt(
            "toolsRemoved",
            (has_context && !prompt.removed.is_empty()).then(|| Value::Array(prompt.removed.into_iter().map(Value::String).collect())),
        )
        .build()
}

struct Prompt {
    instructions: Vec<Value>,
    tools: Vec<Map>,
    removed: Vec<String>,
}

fn prompt_of(message: &Map) -> Prompt {
    let mut instructions = Vec::new();
    if let Some(sections) = message.obj("sections") {
        for (name, text) in entries(sections) {
            if text.is_string() || text.is_null() {
                instructions.push(Obj::new().set("name", name.as_str()).set("text", text.clone()).value());
            }
        }
    }
    let text = text_blocks(message.field("content"));
    if !text.is_empty() {
        instructions.push(Obj::new().set("name", "system").set("text", text).value());
    }
    let mut tools = Vec::new();
    for tool in message.arr("toolsAdded").into_iter().flatten() {
        let Some(name) = tool.str("name").filter(|_| tool.is_object()) else { continue };
        tools.push(
            Obj::new()
                .set("name", name)
                .opt("description", tool.str("description"))
                .opt("parameters", tool.obj("parameters").cloned())
                .build(),
        );
    }
    let removed = message.arr("toolsRemoved").into_iter().flatten().filter_map(|t| t.str("name").map(str::to_string)).collect();
    Prompt { instructions, tools, removed }
}

/// Pi user content as ATXF content: a string, or text and image blocks.
fn user_content(content: Option<&Value>) -> Option<Value> {
    match content? {
        Value::String(s) => Some(Value::String(s.clone())),
        Value::Array(blocks) => {
            let mut out = Vec::new();
            for block in blocks {
                let Some(block) = block.as_object() else { continue };
                match block.str("type") {
                    Some("text") if block.str("text").is_some() => {
                        out.push(Obj::new().set("type", "text").set("text", block["text"].clone()).value())
                    }
                    Some("image") if block.str("mimeType").is_some() => {
                        out.push(
                            Obj::new()
                                .set("type", "image")
                                .set("mediaType", block["mimeType"].clone())
                                .opt("data", block.str("data"))
                                .value(),
                        );
                    }
                    _ => {}
                }
            }
            Some(Value::Array(out))
        }
        _ => None,
    }
}

fn stop_of(value: Option<&Value>) -> Option<&'static str> {
    Some(match value?.as_str()? {
        "stop" => "end",
        "toolUse" => "tool_use",
        "length" => "max_tokens",
        "error" => "error",
        "aborted" => "aborted",
        _ => "other",
    })
}

fn duration(value: Option<&Value>) -> Option<Value> {
    json::as_f64(value?).filter(|n| n.is_finite() && *n >= 0.0).map(number)
}

fn strings(value: Option<&Value>) -> Option<Value> {
    let items = value?.as_array()?;
    items.iter().all(Value::is_string).then(|| Value::Array(items.clone()))
}

/// Pi's compaction details: the files the compacted history read and modified.
fn files_of(details: Option<&Value>) -> Option<Value> {
    let details = details?.as_object()?;
    let files =
        Obj::new().opt("read", strings(details.field("readFiles"))).opt("modified", strings(details.field("modifiedFiles"))).build();
    (!files.is_empty()).then_some(Value::Object(files))
}

/// Pi's record of the calls a tool made, when it has the shape ATXF gives it (SPEC §8).
fn nested_calls_of(value: Option<&Value>) -> Option<Value> {
    let value = value?.as_object()?;
    let (calls, complete) = (value.arr("calls")?, value.bool("complete")?);
    let mut out = Vec::with_capacity(calls.len());
    for call in calls {
        let call = call.as_object()?;
        let status = call.str("status").filter(|s| ["ok", "error", "unfinished"].contains(s))?;
        out.push(
            Obj::new()
                .set("id", call.str("id")?)
                .set("name", call.str("name")?)
                .opt("arguments", call.obj("arguments").cloned())
                .opt("argumentsBytes", count(call.field("argumentsBytes")).map(number))
                .set("status", status)
                .opt("durationMs", duration(call.field("durationMs")))
                .opt("error", call.str("error"))
                .value(),
        );
    }
    Some(Obj::new().set("calls", Value::Array(out)).set("complete", complete).value())
}

fn usage_of(value: Option<&Value>) -> Option<Value> {
    let value = value?.as_object()?;
    let input = count(value.field("input"))?;
    let output = count(value.field("output"))?;
    let cost = value.obj("cost").filter(|c| amount(c.field("total")).is_some());
    Some(
        Obj::new()
            .set("input", number(input))
            .set("output", number(output))
            .opt("cacheRead", count(value.field("cacheRead")).map(number))
            .opt("cacheWrite", count(value.field("cacheWrite")).map(number))
            .opt("cacheWrite1h", count(value.field("cacheWrite1h")).map(number))
            .opt("reasoning", count(value.field("reasoning")).map(number))
            .opt("total", count(value.field("totalTokens")).map(number))
            .opt(
                "cost",
                cost.map(|c| {
                    Obj::new()
                        .opt("input", amount(c.field("input")).map(number))
                        .opt("output", amount(c.field("output")).map(number))
                        .opt("cacheRead", amount(c.field("cacheRead")).map(number))
                        .opt("cacheWrite", amount(c.field("cacheWrite")).map(number))
                        .opt("total", amount(c.field("total")).map(number))
                }),
            )
            .value(),
    )
}

// ATXF → Pi, the whole tree: every record as its Pi entry, with what the record kept of its entry (SPEC §11.2).

/// The session line for a transcript header.
fn session_entry(header: &Map) -> Value {
    let source = header.obj("source");
    let version = match source.and_then(|s| s.field("version")) {
        None => number(3.0),
        Some(v) => {
            let text = to_js_string(v);
            if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) {
                number(text.parse::<f64>().unwrap_or(f64::NAN))
            } else {
                v.clone()
            }
        }
    };
    let parent = header.obj("parent").filter(|p| p.is("relation", "fork"));
    Obj::new()
        .set("type", "session")
        .set("version", version)
        .opt("id", source.and_then(|s| s.field("sessionId")).filter(|v| !v.is_null()).or(header.field("id")).cloned())
        .opt("timestamp", header.field("time").cloned())
        .set("cwd", or_else(header.obj("workspace").and_then(|w| w.field("cwd")), || s("")))
        .opt("parentSession", parent.and_then(|p| p.field("uri").filter(|v| !v.is_null()).or(p.field("transcriptId"))).cloned())
        .value()
}

/// Whether every field of `record` besides its envelope is one of `keys`.
fn only(record: &Map, keys: &[&str]) -> bool {
    record.keys().all(|key| ENVELOPE.contains(&key.as_str()) || keys.contains(&key.as_str()))
}

/// The Pi entry for a record, before its patch. `last` is the last tree record before it, the parent Pi gives an
/// entry that is not part of the tree in ATXF (a label, the session name).
fn pi_entry(record: &Map, last: Option<&str>) -> Value {
    let parent_id = match record.field("parentId") {
        Some(parent) => parent.clone(),
        None if record.contains_key("parentId") => Value::Null,
        None => opt_str(last),
    };
    let entry = |kind: &str, fields: Obj| {
        Obj::new()
            .set("type", kind)
            .opt("id", record.field("id").cloned())
            .set("parentId", parent_id.clone())
            .opt("timestamp", record.field("time").cloned())
            .spread(&fields.build())
            .value()
    };
    let carried = || {
        let data: Map = json::entries(record)
            .filter(|(k, _)| !["id", "time", "ext", "native", "hash"].contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        entry("custom", Obj::new().set("customType", CARRIED).set("data", Value::Object(data)))
    };
    let time = || millis_from_iso(record.time());
    let usage = |key: &str| record.obj(key).map(|u| pi_usage(Some(u)));
    match record.kind() {
        "message" => {
            let origin = record.obj("origin");
            if record.is("role", "user") && origin.is_some_and(|o| o.is("kind", "extension")) {
                let fields = Obj::new()
                    .set("customType", or_else(origin.and_then(|o| o.field("name")), || s("")))
                    .set("content", pi_user_content(record.field("content")))
                    .set("display", or_else(record.field("display"), || Value::Bool(true)));
                return entry("custom_message", fields);
            }
            let began = record.str("startTime").unwrap_or(record.time());
            entry("message", Obj::new().set("message", pi_message(record, millis_from_iso(began))))
        }
        "context" => {
            let message = pi_system(record.arr("instructions"), record.arr("toolsAdded"), record.arr("toolsRemoved"), time());
            entry("message", Obj::new().set("message", message))
        }
        "settings" => {
            if let Some(model) = record.obj("model").filter(|m| only(record, &["model"]) && only(m, &["provider", "id"])) {
                let fields = Obj::new().opt("provider", model.field("provider").cloned()).opt("modelId", model.field("id").cloned());
                return entry("model_change", fields);
            }
            match record.field("reasoningEffort") {
                Some(effort) if only(record, &["reasoningEffort"]) => {
                    entry("thinking_level_change", Obj::new().set("thinkingLevel", effort.clone()))
                }
                _ => carried(),
            }
        }
        "usage" => {
            let model = record.obj("model");
            let fields = Obj::new()
                .opt("kind", record.field("kind").cloned())
                .opt("provider", model.and_then(|m| m.field("provider")).cloned())
                .opt("model", model.and_then(|m| m.field("id")).cloned())
                .set("usage", pi_usage(record.obj("usage")));
            entry("usage", fields)
        }
        "compaction" => {
            let Some(summary) = record.field("summary").filter(|_| record.is("strategy", "summary")) else { return carried() };
            let details = record.obj("files").map(|files| {
                Obj::new().opt("readFiles", files.field("read").cloned()).opt("modifiedFiles", files.field("modified").cloned())
            });
            let system =
                record.obj("snapshot").map(|snapshot| pi_system(snapshot.arr("instructions"), snapshot.arr("tools"), None, time()));
            let fields = Obj::new()
                .set("summary", summary.clone())
                .set("firstKeptEntryId", or_else(record.field("firstKeptId"), || record.field("id").cloned().unwrap_or(Value::Null)))
                .opt("tokensBefore", record.field("tokensBefore").cloned())
                .opt("details", details)
                .opt("usage", usage("usage"))
                .opt("systemMessage", system);
            entry("compaction", fields)
        }
        "context_edit" => {
            let replacement = match record.field("replacement") {
                Some(Value::Null) => Value::Null,
                other => pi_user_content(other),
            };
            entry("context_edit", Obj::new().opt("targetId", record.field("targetId").cloned()).set("replacement", replacement))
        }
        "branch_summary" => entry(
            "branch_summary",
            Obj::new()
                .opt("fromId", record.field("fromId").cloned())
                .opt("summary", record.field("summary").cloned())
                .opt("usage", usage("usage")),
        ),
        "custom" if record.is("namespace", ENTRY) => record.field("data").cloned().unwrap_or(Value::Null),
        "custom" if record.is("namespace", AGENT) => {
            entry("custom", Obj::new().opt("customType", record.field("name").cloned()).opt("data", record.field("data").cloned()))
        }
        "label" => {
            entry("label", Obj::new().opt("targetId", record.field("targetId").cloned()).opt("label", record.field("label").cloned()))
        }
        "metadata" => match record.field("title") {
            Some(title) if only(record, &["title"]) => entry("session_info", Obj::new().set("name", title.clone())),
            _ => carried(),
        },
        _ => carried(),
    }
}

/// A Pi system message: instructions as sections, the one named `system` as its content.
fn pi_system(instructions: Option<&Vec<Value>>, tools: Option<&Vec<Value>>, removed: Option<&Vec<Value>>, timestamp: f64) -> Value {
    let instructions = instructions.map(Vec::as_slice).unwrap_or_default();
    let is_system = |section: &Value| section.is("name", "system");
    let mut sections = Map::new();
    for section in instructions.iter().filter(|section| !is_system(section)) {
        if let Some(text) = section.field("text") {
            sections.insert(section.field("name").map(to_js_string).unwrap_or_else(|| "undefined".to_string()), text.clone());
        }
    }
    let content = or_else(instructions.iter().find(|section| is_system(section)).and_then(|section| section.field("text")), || s(""));
    let tools = tools.map(|tools| {
        Value::Array(
            tools
                .iter()
                .map(|tool| {
                    Obj::new()
                        .opt("name", tool.field("name").cloned())
                        .opt("description", tool.field("description").cloned())
                        .opt("parameters", tool.field("parameters").cloned())
                        .value()
                })
                .collect(),
        )
    });
    let removed = removed.map(|names| Value::Array(names.iter().map(|name| Obj::new().set("name", name.clone()).value()).collect()));
    Obj::new()
        .set("role", "system")
        .set("content", content)
        .opt("sections", (!instructions.iter().all(is_system)).then_some(Value::Object(sections)))
        .opt("toolsAdded", tools)
        .opt("toolsRemoved", removed)
        .set("timestamp", number(timestamp))
        .value()
}

/// `value` with the patch `kept` holds in `ext.pi`; unpatched when the patch no longer applies.
fn restored(kept: &Map, value: Value) -> Value {
    match kept.obj("ext").and_then(|ext| ext.obj(AGENT)).and_then(|pi| pi.arr("patch")) {
        Some(patch) => apply(&value, patch).unwrap_or(value),
        None => value,
    }
}

/// Every record as its Pi entry. Each entry is read back, and one whose record does not come back as written gets
/// `atxf.patch`, which turns the record read into the record written, so a transcript from any source survives
/// (SPEC §11.2). Pi ignores the `atxf` key, as it does the mark of a carried transcript.
fn encode_tree(transcript: &Transcript) -> Vec<TreeUnit> {
    let mut out = tree_entries(transcript);
    let text: String = out
        .iter()
        .map(|unit| match unit {
            TreeUnit::Value(value) => Jsonl.canonical(value),
            TreeUnit::Raw(text) => format!("{text}\n"),
        })
        .collect();
    let Ok(back) = Converter::to_atxf(&Pi, &text, false) else { return out };
    let Some(offset) = out.len().checked_sub(transcript.records.len()) else { return out };
    if back.records.len() != transcript.records.len() {
        return out;
    }
    let reverse = |unit: &mut TreeUnit, to: Value, from: Value| {
        let patch = diff(&to, &from);
        if let TreeUnit::Value(Value::Object(entry)) = unit
            && !patch.is_empty()
            && !entry.contains_key("atxf")
        {
            entry.insert("atxf".to_string(), Obj::new().set("patch", Value::Array(patch)).value());
        }
    };
    if offset == 1 {
        reverse(&mut out[0], comparable_header(&transcript.header), comparable_header(&back.header));
    }
    for (index, (record, read)) in transcript.records.iter().zip(&back.records).enumerate() {
        reverse(&mut out[offset + index], comparable(record), comparable(read));
    }
    out
}

/// What a record keeps when written without native: not native, nor what integrity recomputes.
fn comparable(record: &Map) -> Value {
    let mut record = record.clone();
    record.shift_remove("native");
    record.shift_remove("hash");
    Value::Object(record)
}

fn comparable_header(header: &Map) -> Value {
    let mut header = header.clone();
    for key in ["native", "hash", "integrity"] {
        header.shift_remove(key);
    }
    // Whether the transcript holds native records, and the digest of their file, are the reader's to say.
    if let Some(Value::Object(fidelity)) = header.shift_remove("fidelity") {
        let kept: Map = fidelity.into_iter().filter(|(k, _)| k != "nativeDigest" && k != "native").collect();
        header.insert("fidelity".to_string(), Value::Object(kept));
    }
    Value::Object(header)
}

fn tree_entries(transcript: &Transcript) -> Vec<TreeUnit> {
    let header = &transcript.header;
    let mut out = Vec::with_capacity(transcript.records.len() + 1);
    if header.obj("ext").and_then(|ext| ext.obj(AGENT)).and_then(|pi| pi.bool("session")) != Some(false) {
        out.push(TreeUnit::Value(restored(header, session_entry(header))));
    }
    let mut last: Option<&str> = None;
    for record in &transcript.records {
        if is_line(record) {
            out.push(TreeUnit::Raw(record.obj("data").and_then(|d| d.str("text")).unwrap_or("").to_string()));
        } else {
            out.push(TreeUnit::Value(restored(record, pi_entry(record, last))));
        }
        if record.contains_key("parentId") {
            last = Some(record.id());
        }
    }
    out
}

// ATXF → Pi: the active context as a linear Pi session.

struct Writer<'a> {
    out: Vec<Encoded>,
    ids: IdAllocator,
    parent_id: Option<String>,
    time: Value,
    times: HashMap<&'a str, &'a str>,
}

impl Writer<'_> {
    fn entry(&mut self, kind: &str, fields: Obj, source: Option<&str>) {
        if let Some(source) = source
            && let Some(t) = self.times.get(source)
        {
            self.time = s(*t);
        }
        let id = self.ids.take(source.unwrap_or("atxf"));
        let value = Obj::new()
            .set("type", kind)
            .set("id", id.as_str())
            .set("parentId", opt_str(self.parent_id.as_deref()))
            .set("timestamp", self.time.clone())
            .spread(&fields.set("type", kind).build());
        self.out.push(Encoded { value: value.value(), source: source.map(str::to_string) });
        self.parent_id = Some(id);
    }

    fn time_str(&self) -> &str {
        self.time.as_str().unwrap_or("")
    }
}

fn encode(transcript: &Transcript) -> Vec<Encoded> {
    let context = build_context(transcript, &BuildContextOptions::default());
    let header = &transcript.header;
    let mut w = Writer {
        out: Vec::new(),
        ids: IdAllocator::default(),
        parent_id: None,
        time: header.field("time").cloned().unwrap_or(Value::Null),
        times: transcript.records.iter().map(|r| (r.id(), r.time())).collect(),
    };
    let cwd = or_else(header.obj("workspace").and_then(|w| w.field("cwd")), || or_else(context.settings.field("cwd"), || s("")));
    w.out.push(Encoded {
        value: Obj::new()
            .set("type", "session")
            .set("version", 3)
            .set(
                "id",
                or_else(header.obj("source").and_then(|s| s.field("sessionId")), || header.field("id").cloned().unwrap_or(Value::Null)),
            )
            .opt("timestamp", header.field("time").cloned())
            .set("cwd", cwd)
            .value(),
        source: None,
    });

    if !context.instructions.is_empty() || !context.tools.is_empty() {
        let sections = (!context.instructions.is_empty()).then(|| {
            let mut map = Map::new();
            for (name, text) in &context.instructions {
                map.insert(name.clone(), s(text.as_str()));
            }
            Value::Object(map)
        });
        let tools = (!context.tools.is_empty()).then(|| {
            Value::Array(
                context
                    .tools
                    .iter()
                    .map(|t| {
                        Obj::new()
                            .set("name", t.field("name").cloned().unwrap_or(Value::Null))
                            .set("description", or_else(t.field("description"), || s("")))
                            .set("parameters", or_else(t.field("parameters"), || Value::Object(Map::new())))
                            .value()
                    })
                    .collect(),
            )
        });
        let timestamp = number(millis_from_iso(w.time_str()));
        let message = Obj::new()
            .set("role", "system")
            .set("content", "")
            .opt("sections", sections)
            .opt("toolsAdded", tools)
            .set("timestamp", timestamp);
        w.entry("message", Obj::new().set("message", message), None);
    }
    if let Some(model) = context.model() {
        let fields = Obj::new()
            .set("provider", model.field("provider").cloned().unwrap_or(Value::Null))
            .set("modelId", model.field("id").cloned().unwrap_or(Value::Null));
        w.entry("model_change", fields, None);
    }
    if let Some(effort) = context.settings.field("reasoningEffort").filter(|v| json::truthy(v)) {
        w.entry("thinking_level_change", Obj::new().set("thinkingLevel", effort.clone()), None);
    }

    for message in &context.messages {
        // A summary first in the context is a retain-none compaction. Later on it must not cut the context: it is a
        // branch summary.
        let source = message.source_id.as_str();
        if message.kind.is_summary() && w.parent_id.is_none() {
            let id = w.ids.take(source);
            if let Some(t) = w.times.get(source) {
                w.time = s(*t);
            }
            // Retain-none: Pi marks it by pointing firstKeptEntryId at the compaction itself.
            let value = Obj::new()
                .set("type", "compaction")
                .set("id", id.as_str())
                .set("parentId", Value::Null)
                .set("timestamp", w.time.clone())
                .set("summary", text_blocks(message.body.field("content")))
                .set("firstKeptEntryId", id.as_str())
                .set("tokensBefore", 0);
            w.out.push(Encoded { value: value.value(), source: Some(source.to_string()) });
            w.parent_id = Some(id);
            continue;
        }
        if message.kind.is_summary() {
            let fields =
                Obj::new().set("fromId", opt_str(w.parent_id.as_deref())).set("summary", text_blocks(message.body.field("content")));
            w.entry("branch_summary", fields, Some(source));
            continue;
        }
        let body = &message.body;
        let origin = body.obj("origin");
        let hidden = body.field("display") == Some(&Value::Bool(false));
        if body.is("role", "user") && (origin.is_some_and(|o| o.field("kind") != Some(&s("human"))) || hidden) {
            // Pi's form for context that no person typed, or that is hidden: a custom message.
            let custom_type = match origin {
                Some(o) => [o.field("kind"), o.field("name")]
                    .into_iter()
                    .flatten()
                    .filter(|v| json::truthy(v))
                    .map(to_js_string)
                    .collect::<Vec<_>>()
                    .join(":"),
                None => "atxf".to_string(),
            };
            let fields = Obj::new()
                .set("customType", custom_type)
                .set("content", pi_user_content(body.field("content")))
                .set("display", or_else(body.field("display"), || Value::Bool(true)));
            w.entry("custom_message", fields, Some(source));
            continue;
        }
        let time = w.times.get(source).copied().unwrap_or(w.time_str()).to_string();
        let fields = Obj::new().set("message", pi_message(body, millis_from_iso(&time)));
        w.entry("message", fields, Some(source));
    }
    w.out
}

fn pi_stop(stop: Option<&Value>) -> Option<&'static str> {
    Some(match stop.and_then(Value::as_str).unwrap_or("end") {
        "end" | "refusal" | "other" => "stop",
        "tool_use" => "toolUse",
        "max_tokens" => "length",
        "error" => "error",
        "aborted" => "aborted",
        _ => return None,
    })
}

fn pi_message(body: &Map, timestamp: f64) -> Value {
    let timestamp = number(timestamp);
    match body.str("role").unwrap_or("") {
        "system" => {
            let content = match body.field("content") {
                Some(Value::String(s)) => s.clone(),
                other => text_blocks(other),
            };
            Obj::new().set("role", "system").set("content", content).set("timestamp", timestamp).value()
        }
        "user" => Obj::new().set("role", "user").set("content", pi_user_content(body.field("content"))).set("timestamp", timestamp).value(),
        "tool" => {
            let content = match body.field("content") {
                Some(Value::String(text)) => Value::Array(vec![Obj::new().set("type", "text").set("text", text.as_str()).value()]),
                other => pi_user_content(other),
            };
            Obj::new()
                .set("role", "toolResult")
                .opt("toolCallId", body.field("toolCallId").cloned())
                .set("toolName", or_else(body.field("toolName"), || s("")))
                .set("content", content)
                .opt("details", body.field("details").cloned())
                .opt("nestedCalls", body.field("nestedCalls").cloned())
                .set("isError", body.field("isError") == Some(&Value::Bool(true)))
                .set("timestamp", timestamp)
                .opt("durationMs", body.field("durationMs").cloned())
                .value()
        }
        "assistant" => {
            let signature = |block: &Value, kind: &str| replay_data(block.field("replay"), kind, None, true).cloned();
            let content: Vec<Value> = body
                .arr("content")
                .into_iter()
                .flatten()
                .map(|block| match block.str("type") {
                    Some("text") => Obj::new()
                        .set("type", "text")
                        .opt("text", block.field("text").cloned())
                        .opt("textSignature", signature(block, "text_signature"))
                        .value(),
                    Some("reasoning") => {
                        let thinking = match block.defined("text") {
                            Some(text) => text.clone(),
                            None => s(block.arr("summary").into_iter().flatten().map(to_js_string_or_empty).collect::<Vec<_>>().join("\n")),
                        };
                        Obj::new()
                            .set("type", "thinking")
                            .set("thinking", thinking)
                            .opt("thinkingSignature", signature(block, "signature"))
                            .opt("redacted", block.field("redacted").cloned())
                            .value()
                    }
                    Some("tool_call") => {
                        let arguments = match block.defined("arguments") {
                            Some(args) => args.clone(),
                            None => match block.field("input") {
                                None => Value::Object(Map::new()),
                                Some(input) => Obj::new().set("input", input.clone()).value(),
                            },
                        };
                        Obj::new()
                            .set("type", "toolCall")
                            .opt("id", block.field("id").cloned())
                            .opt("name", block.field("name").cloned())
                            .set("arguments", arguments)
                            .opt("namespace", block.field("namespace").cloned())
                            .opt("thoughtSignature", signature(block, "thought_signature"))
                            .value()
                    }
                    Some("image") => Obj::new().set("type", "text").set("text", "[image]").value(),
                    _ => Value::Null,
                })
                .collect();
            let model = body.obj("model");
            Obj::new()
                .set("role", "assistant")
                .set("content", Value::Array(content))
                .set("api", or_else(model.and_then(|m| m.field("api")), || s("unknown")))
                .set("provider", or_else(model.and_then(|m| m.field("provider")), || s("unknown")))
                .set("model", or_else(model.and_then(|m| m.field("id")), || s("unknown")))
                .opt("responseId", body.field("responseId").cloned())
                .opt("responseModel", body.field("responseModel").cloned())
                .opt("thinkingLevel", body.field("reasoningEffort").cloned())
                .opt("providerThinkingLevel", body.field("providerReasoningEffort").cloned())
                .set("usage", pi_usage(body.obj("usage")))
                .opt("stopReason", pi_stop(body.field("stop").filter(|v| !v.is_null())))
                .opt("rawStopReason", body.field("rawStop").cloned())
                .opt("errorMessage", body.obj("error").and_then(|e| e.field("message")).cloned())
                .set("timestamp", timestamp)
                .opt("durationMs", body.field("durationMs").cloned())
                .value()
        }
        _ => Value::Null,
    }
}

/// Usage as Pi writes it: every bucket and cost present, zero when unknown.
fn pi_usage(usage: Option<&Map>) -> Value {
    let cost = usage.and_then(|u| u.obj("cost"));
    let n = |m: Option<&Map>, key: &str| or_else(m.and_then(|m| m.field(key)), || number(0.0));
    let total = match usage {
        Some(u) => match u.defined("total") {
            Some(total) => total.clone(),
            None => number(
                json::as_f64(u.field("input").unwrap_or(&Value::Null)).unwrap_or(f64::NAN)
                    + json::as_f64(u.field("output").unwrap_or(&Value::Null)).unwrap_or(f64::NAN),
            ),
        },
        None => number(0.0),
    };
    Obj::new()
        .set("input", n(usage, "input"))
        .set("output", n(usage, "output"))
        .set("cacheRead", n(usage, "cacheRead"))
        .set("cacheWrite", n(usage, "cacheWrite"))
        .opt("cacheWrite1h", usage.and_then(|u| u.field("cacheWrite1h")).cloned())
        .opt("reasoning", usage.and_then(|u| u.field("reasoning")).cloned())
        .set("totalTokens", total)
        .set(
            "cost",
            Obj::new()
                .set("input", n(cost, "input"))
                .set("output", n(cost, "output"))
                .set("cacheRead", n(cost, "cacheRead"))
                .set("cacheWrite", n(cost, "cacheWrite"))
                .set("total", n(cost, "total")),
        )
        .value()
}

/// `String(v)` as `Array.prototype.join` writes it: `null` as empty.
fn to_js_string_or_empty(v: &Value) -> String {
    if v.is_null() { String::new() } else { to_js_string(v) }
}

fn pi_user_content(content: Option<&Value>) -> Value {
    match content {
        Some(Value::Array(blocks)) => Value::Array(
            blocks
                .iter()
                .map(|block| match block.str("type") {
                    Some("text") => Obj::new().set("type", "text").opt("text", block.field("text").cloned()).value(),
                    Some("image") if block.field("data").is_some() => Obj::new()
                        .set("type", "image")
                        .set("data", block["data"].clone())
                        .opt("mimeType", block.field("mediaType").cloned())
                        .value(),
                    Some("image") => {
                        let uri = or_else(block.field("uri"), || s(""));
                        Obj::new()
                            .set("type", "text")
                            .set("text", json::trim(&format!("[image {}]", to_js_string(&uri))).to_string())
                            .value()
                    }
                    _ => {
                        let text = or_else(block.field("text"), || {
                            s(format!("[{}]", block.field("uri").map_or_else(|| "undefined".to_string(), to_js_string)))
                        });
                        Obj::new().set("type", "text").set("text", text).value()
                    }
                })
                .collect(),
        ),
        Some(other) => other.clone(),
        None => Value::Null,
    }
}
