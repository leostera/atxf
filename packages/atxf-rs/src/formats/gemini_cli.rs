//! Gemini CLI chat recordings (`~/.gemini/tmp/<project>/chats/session-*.jsonl`), following
//! `packages/core/src/services/chatRecordingTypes.ts`: a metadata line, then message records and `$set`, `$patch`
//! and `$rewindTo` operations.

use std::collections::HashMap;

use super::pi::detach_from_atxf_key;
use super::{Node, obj_or_empty, opt_str, or_else};
use crate::codec::{DecodeContext, Decoded, Encoded, FormatSpec, IdAllocator, TreeBuilder, carried_value, mark_id};
use crate::context::{BuildContextOptions, build_context};
use crate::equivalence::content_text;
use crate::json::{self, Get, Map, Obj, Value, count, number, s, to_js_string};
use crate::native::{Framing, Jsonl, Unit, native_of, native_of_shared};
use crate::time::{EPOCH, iso_time};
use crate::transcript::{Record, Transcript};

pub struct GeminiCli;

const AGENT: &str = "gemini-cli";
const FORMAT: &str = "gemini-cli/chat-jsonl";

fn native(unit: &Unit) -> Map {
    native_of(&[unit], AGENT, FORMAT, &Jsonl)
}

fn is_metadata(value: &Value) -> bool {
    value.str("sessionId").is_some() && value.field("type").is_none() && !value.has("$set")
}

impl FormatSpec for GeminiCli {
    const AGENT: &'static str = AGENT;
    const FORMAT: &'static str = FORMAT;

    fn framing(&self) -> &dyn Framing {
        &Jsonl
    }

    fn decode(&self, units: &[Unit], context: DecodeContext<'_>) -> Decoded {
        let mut tree = TreeBuilder::new(context);
        let mut start = 0;
        let header = match units.first().map(|u| &u.value) {
            Some(first @ Value::Object(meta)) if is_metadata(first) && !tree.is_known(0) => {
                start = 1;
                session_header(meta, Some(native(&units[0])))
            }
            _ => session_header(&Map::new(), None),
        };
        let header_time = header.str("time").unwrap_or(EPOCH).to_string();
        // The active position: Gemini's rewinds move it back to before a message.
        let mut leaf = tree.last.clone();

        for (index, unit) in units.iter().enumerate().skip(start) {
            let record = obj_or_empty(Some(&unit.value));
            let native_id = record.field("id").cloned();
            if tree.is_known(index) {
                let known = tree.known(index);
                if let Some(Value::String(_)) = &native_id {
                    tree.alias(native_id.as_ref(), known.clone().or_else(|| leaf.clone()));
                }
                if let Some(known) = known.filter(|k| !k.is_empty()) {
                    leaf = Some(known);
                }
                continue;
            }
            let preferred = match (record.nonempty("id"), record.str("type")) {
                (Some(id), Some(_)) => id.to_string(),
                _ => format!("gemini-{index}"),
            };
            let id = tree.take_id(&preferred);
            let time = iso_time(record.field("timestamp"), &header_time);
            let node = Node { id: id.clone(), parent_id: leaf.clone(), time: time.clone() };
            let push_node = |tree: &mut TreeBuilder<'_>, leaf: &mut Option<String>, entry: Map, extra: Vec<Map>| {
                let entry_id = entry.id().to_string();
                tree.push(entry, Some(native(unit)));
                let mut last = entry_id.clone();
                for derived in extra {
                    last = derived.id().to_string();
                    tree.push(derived, Some(native_of_shared(&entry_id, AGENT, FORMAT)));
                }
                if let Some(Value::String(_)) = &native_id {
                    tree.alias(native_id.as_ref(), Some(entry_id));
                }
                *leaf = Some(last);
            };
            let custom = |tree: &mut TreeBuilder<'_>, leaf: &mut Option<String>, name: &str| {
                push_node(tree, leaf, node.record("custom").set("namespace", AGENT).set("name", name).build(), vec![]);
            };

            if record.str("$rewindTo").is_some() {
                let Some(target) = tree.resolve(record.field("$rewindTo")) else {
                    custom(&mut tree, &mut leaf, "$rewindTo");
                    continue;
                };
                // Rewinding to a message removes it and what follows: the position moves to its parent.
                let target_id =
                    tree.records.iter().find(|r| r.id() == target && r.has("parentId")).and_then(|r| r.parent_id()).map(str::to_string);
                let entry = Obj::new()
                    .set("type", "leaf")
                    .set("id", id.as_str())
                    .set("time", time.as_str())
                    .set("targetId", opt_str(target_id.as_deref()))
                    .set("reason", "rewind")
                    .build();
                tree.push(entry, Some(native(unit)));
                leaf = target_id;
                continue;
            }
            if let Some(summary) = record.obj("$set").and_then(|s| s.str("summary")) {
                tree.push(
                    Obj::new().set("type", "metadata").set("id", id.as_str()).set("time", time.as_str()).set("title", summary).build(),
                    Some(native(unit)),
                );
                continue;
            }
            match record.str("type") {
                Some("user") => match parts_content(record.field("content")) {
                    Some(content) => {
                        push_node(&mut tree, &mut leaf, node.record("message").set("role", "user").set("content", content).build(), vec![])
                    }
                    None => custom(&mut tree, &mut leaf, "user"),
                },
                Some("gemini") => {
                    let mut records = gemini_records(&record, &node, &mut tree).into_iter();
                    match records.next() {
                        Some(assistant) => push_node(&mut tree, &mut leaf, assistant, records.collect()),
                        None => custom(&mut tree, &mut leaf, "gemini"),
                    }
                }
                other => {
                    let name = match other {
                        Some(kind) => kind.to_string(),
                        None => {
                            json::keys(&record).into_iter().find(|k| k.starts_with('$')).cloned().unwrap_or_else(|| "unparsed".to_string())
                        }
                    };
                    custom(&mut tree, &mut leaf, &name);
                }
            }
        }
        Decoded { header, records: tree.records }
    }

    fn encode(&self, transcript: &Transcript) -> Vec<Encoded> {
        encode(transcript)
    }

    fn mark(&self, value: Value, source: Option<&str>) -> Value {
        Obj::new().spread(&obj_or_empty(Some(&value))).set("atxf", Obj::new().set("id", opt_str(source))).value()
    }

    fn mark_of(&self, value: &Value) -> Option<Option<String>> {
        mark_id(value.obj("atxf"))
    }

    fn attach(&self, values: Vec<Value>, transcript: &Transcript) -> Vec<Value> {
        let mut values = values.into_iter();
        let meta = obj_or_empty(values.next().as_ref());
        let atxf = Obj::new().spread(&obj_or_empty(meta.field("atxf"))).set("transcript", carried_value(transcript));
        let mut out = vec![Obj::new().spread(&meta).set("atxf", atxf).value()];
        out.extend(values);
        out
    }

    fn detach(&self, units: &[Unit]) -> Option<(Value, Vec<Unit>)> {
        detach_from_atxf_key(units)
    }
}

fn session_header(meta: &Map, native: Option<Map>) -> Map {
    let roots = meta.arr("directories").filter(|d| !d.is_empty() && d.iter().all(Value::is_string)).cloned();
    Obj::new()
        .set("type", "transcript")
        .set("atxf", "0.1")
        .set("id", meta.nonempty("sessionId").unwrap_or("gemini-session"))
        .set("time", iso_time(meta.field("startTime"), EPOCH))
        .opt("title", meta.str("summary"))
        .set("source", Obj::new().set("agent", AGENT).set("format", FORMAT).opt("sessionId", meta.str("sessionId")))
        .opt("workspace", roots.map(|r| Obj::new().set("roots", Value::Array(r))))
        .set("fidelity", Obj::new().set("topology", "linear").set("reasoning", "summary").set("native", "all").set("ids", "stable"))
        .opt("native", native)
        .build()
}

/// Gemini `PartListUnion` as ATXF content: text parts as text, inline images as images, anything else dropped.
fn parts_content(parts: Option<&Value>) -> Option<Value> {
    let list: Vec<&Value> = match parts? {
        Value::String(text) => return Some(s(text.as_str())),
        Value::Array(items) => items.iter().collect(),
        part @ Value::Object(_) => vec![part],
        _ => return None,
    };
    let mut blocks = Vec::new();
    for part in list {
        if let Value::String(text) = part {
            blocks.push(Obj::new().set("type", "text").set("text", text.as_str()).value());
        } else if let Some(text) = part.str("text") {
            blocks.push(Obj::new().set("type", "text").set("text", text).value());
        } else if let Some(mime) = part.obj("inlineData").and_then(|d| d.str("mimeType")) {
            blocks.push(
                Obj::new()
                    .set("type", "image")
                    .set("mediaType", mime)
                    .opt("data", part.obj("inlineData").and_then(|d| d.str("data")))
                    .value(),
            );
        } else if let Some(function) = part.obj("functionResponse") {
            let response = function.field("response");
            let text = match response.and_then(|r| r.str("output")) {
                Some(output) => output.to_string(),
                None => json::stringify(response.unwrap_or(&Value::Null)),
            };
            blocks.push(Obj::new().set("type", "text").set("text", text).value());
        }
    }
    Some(Value::Array(blocks))
}

/// A `gemini` record: the assistant message, then one tool message for each tool call with a result.
fn gemini_records(record: &Map, node: &Node, tree: &mut TreeBuilder<'_>) -> Vec<Map> {
    let model = record.str("model").map(|m| Obj::new().set("provider", "google").set("id", m));
    let mut content: Vec<Value> = Vec::new();
    for thought in record.arr("thoughts").into_iter().flatten() {
        if !thought.is_object() {
            continue;
        }
        let text = [thought.field("subject"), thought.field("description")]
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join(": ");
        content.push(Obj::new().set("type", "reasoning").set("summary", Value::Array(vec![s(text)])).value());
    }
    match parts_content(record.field("content")) {
        Some(Value::String(text)) => content.push(Obj::new().set("type", "text").set("text", text).value()),
        Some(Value::Array(blocks)) => content.extend(blocks.into_iter().filter(|b| b.is("type", "text"))),
        _ => {}
    }
    let mut results = Vec::new();
    let mut parent_id = node.id.clone();
    for call in record.arr("toolCalls").into_iter().flatten() {
        let (Some(id), Some(name)) = (call.str("id"), call.str("name")) else { continue };
        if !call.is_object() || tree.has_tool_call(id) || content.iter().any(|b| b.is("type", "tool_call") && b.str("id") == Some(id)) {
            continue;
        }
        content.push(
            Obj::new()
                .set("type", "tool_call")
                .set("id", id)
                .set("name", name)
                .set("arguments", call.obj("args").cloned().unwrap_or_default())
                .value(),
        );
        if call.defined("result").is_some() {
            let result_id = tree.take_id(&format!("{}:{id}", node.id));
            results.push(
                Obj::new()
                    .set("type", "message")
                    .set("id", result_id.as_str())
                    .set("parentId", parent_id.as_str())
                    .set("time", iso_time(call.field("timestamp"), &node.time))
                    .set("role", "tool")
                    .set("toolCallId", id)
                    .set("toolName", name)
                    .set("content", parts_content(call.field("result")).unwrap_or_else(|| s("")))
                    .opt("isError", call.is("status", "error").then_some(true))
                    .build(),
            );
            parent_id = result_id;
        }
    }
    let tokens = obj_or_empty(record.field("tokens"));
    let usage = match (count(tokens.field("input")), count(tokens.field("output"))) {
        (Some(input), Some(output)) => Some(
            Obj::new()
                .set("input", number(input))
                .set("output", number(output))
                .opt("cacheRead", count(tokens.field("cached")).map(number))
                .opt("reasoning", count(tokens.field("thoughts")).map(number))
                .opt("total", count(tokens.field("total")).map(number)),
        ),
        _ => None,
    };
    let assistant = node
        .record("message")
        .set("role", "assistant")
        .set("content", Value::Array(content))
        .opt("model", model)
        .opt("usage", usage)
        .build();
    let mut out = vec![assistant];
    out.extend(results);
    out
}

fn encode(transcript: &Transcript) -> Vec<Encoded> {
    let context = build_context(transcript, &BuildContextOptions::default());
    let header = &transcript.header;
    let header_time = header.field("time").cloned().unwrap_or(Value::Null);
    let times: HashMap<&str, &str> = transcript.records.iter().map(|r| (r.id(), r.time())).collect();
    let mut ids = IdAllocator::default();
    let mut results: Vec<(String, &Map)> = Vec::new();
    for message in &context.messages {
        if let (true, Some(call)) = (message.body.is("role", "tool"), message.body.str("toolCallId"))
            && !results.iter().any(|(k, _)| k == call)
        {
            results.push((call.to_string(), &message.body));
        }
    }
    let last_time = transcript.records.last().map_or_else(|| header_time.clone(), |r| s(r.time()));
    let meta = Obj::new()
        .set(
            "sessionId",
            or_else(header.obj("source").and_then(|s| s.field("sessionId")), || header.field("id").cloned().unwrap_or(Value::Null)),
        )
        .set("projectHash", "atxf")
        .opt("startTime", header.field("time").cloned())
        .set("lastUpdated", last_time)
        .opt("summary", header.field("title").cloned())
        .set("kind", "main");
    let mut out = vec![Encoded { value: meta.value(), source: None }];

    for message in &context.messages {
        let body = &message.body;
        let source = message.source_id.as_str();
        let timestamp = times.get(source).map_or_else(|| header_time.clone(), |t| s(*t));
        let base = Obj::new().set("id", ids.take(source)).set("timestamp", timestamp.clone());
        let push = |out: &mut Vec<Encoded>, value: Obj| out.push(Encoded { value: value.value(), source: Some(source.to_string()) });
        if message.kind.is_summary() {
            // Gemini CLI has no summary record: a summary is a user message.
            push(&mut out, base.set("type", "user").set("content", content_text(body.field("content"))));
            continue;
        }
        match body.str("role").unwrap_or("") {
            "system" => push(&mut out, base.set("type", "info").set("content", content_text(body.field("content")))),
            "user" => {
                let hidden = body.field("display") == Some(&Value::Bool(false))
                    || body.obj("origin").is_some_and(|o| o.field("kind") != Some(&s("human")));
                push(&mut out, base.set("type", if hidden { "info" } else { "user" }).set("content", gemini_parts(body.field("content"))));
            }
            "assistant" => {
                let blocks = body.arr("content").map_or(&[][..], Vec::as_slice);
                let text = blocks
                    .iter()
                    .filter(|b| b.is("type", "text"))
                    .map(|b| match b.field("text") {
                        None | Some(Value::Null) => String::new(),
                        Some(t) => to_js_string(t),
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let thoughts: Vec<Value> = blocks
                    .iter()
                    .filter(|b| b.is("type", "reasoning"))
                    .map(|b| {
                        let description = match b.defined("text") {
                            Some(t) => t.clone(),
                            None => s(b
                                .arr("summary")
                                .into_iter()
                                .flatten()
                                .map(|v| if v.is_null() { String::new() } else { to_js_string(v) })
                                .collect::<Vec<_>>()
                                .join("\n")),
                        };
                        Obj::new().set("subject", "").set("description", description).set("timestamp", timestamp.clone()).value()
                    })
                    .collect();
                let calls: Vec<Value> = blocks
                    .iter()
                    .filter(|b| b.is("type", "tool_call"))
                    .map(|b| {
                        let result = b.str("id").and_then(|id| results.iter().find(|(k, _)| k == id)).map(|(_, r)| *r);
                        let args = match b.defined("arguments") {
                            Some(args) => args.clone(),
                            None => Obj::new().set("input", or_else(b.field("input"), || s(""))).value(),
                        };
                        let status = match result {
                            Some(r) if r.field("isError").is_some_and(json::truthy) => "error",
                            Some(_) => "success",
                            None => "scheduled",
                        };
                        Obj::new()
                            .opt("id", b.field("id").cloned())
                            .opt("name", b.field("name").cloned())
                            .set("args", args)
                            .opt(
                                "result",
                                result.map(|r| Value::Array(vec![Obj::new().set("text", content_text(r.field("content"))).value()])),
                            )
                            .set("status", status)
                            .set("timestamp", timestamp.clone())
                            .value()
                    })
                    .collect();
                let usage = body.obj("usage");
                let tokens = usage.map(|u| {
                    let total = match u.defined("total") {
                        Some(t) => t.clone(),
                        None => number(
                            json::as_f64(u.field("input").unwrap_or(&Value::Null)).unwrap_or(f64::NAN)
                                + json::as_f64(u.field("output").unwrap_or(&Value::Null)).unwrap_or(f64::NAN),
                        ),
                    };
                    Obj::new()
                        .opt("input", u.field("input").cloned())
                        .opt("output", u.field("output").cloned())
                        .set("cached", or_else(u.field("cacheRead"), || number(0.0)))
                        .opt("thoughts", u.field("reasoning").cloned())
                        .set("total", total)
                });
                let value = base
                    .set("type", "gemini")
                    .set("content", text)
                    .opt("thoughts", (!thoughts.is_empty()).then_some(Value::Array(thoughts)))
                    .opt("toolCalls", (!calls.is_empty()).then_some(Value::Array(calls)))
                    .opt("tokens", tokens)
                    .opt("model", body.obj("model").and_then(|m| m.field("id")).cloned());
                push(&mut out, value);
            }
            _ => {}
        }
    }
    out
}

fn gemini_parts(content: Option<&Value>) -> Value {
    match content {
        Some(Value::Array(blocks)) => Value::Array(
            blocks
                .iter()
                .map(|block| match block.str("type") {
                    Some("text") => Obj::new().opt("text", block.field("text").cloned()).value(),
                    Some("image") if block.field("data").is_some() => Obj::new()
                        .set("inlineData", Obj::new().opt("mimeType", block.field("mediaType").cloned()).set("data", block["data"].clone()))
                        .value(),
                    Some("image") => Obj::new().set("text", "[image]").value(),
                    _ => {
                        let text = or_else(block.field("text"), || {
                            s(format!("[{}]", block.field("uri").map_or_else(|| "undefined".to_string(), to_js_string)))
                        });
                        Obj::new().set("text", text).value()
                    }
                })
                .collect(),
        ),
        Some(other) => other.clone(),
        None => Value::Null,
    }
}
