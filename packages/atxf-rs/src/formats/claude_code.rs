//! Claude Code session files (`~/.claude/projects/<project>/<session>.jsonl`), as written by Claude Code 2.1.
//! Anthropic calls the format internal and unstable; this converter follows the entries observed in real sessions.

use std::collections::{HashMap, HashSet};

use super::{Node, obj_or_empty, opt_str, or_else, replay_data, text_blocks};
use crate::canonical::sha256;
use crate::codec::{DecodeContext, Decoded, Encoded, FormatSpec, TreeBuilder, carried_value, mark_id};
use crate::context::{BuildContextOptions, build_context};
use crate::json::{Get, Map, Obj, Value, count, number, s, to_js_string};
use crate::native::{Framing, Jsonl, Unit, native_of, native_of_shared};
use crate::time::{EPOCH, iso_time};
use crate::transcript::{Record, Transcript};

pub struct ClaudeCode;

const AGENT: &str = "claude-code";
const FORMAT: &str = "claude-code/session-jsonl";

fn native(unit: &Unit) -> Map {
    native_of(&[unit], AGENT, FORMAT, &Jsonl)
}

impl FormatSpec for ClaudeCode {
    const AGENT: &'static str = AGENT;
    const FORMAT: &'static str = FORMAT;

    fn framing(&self) -> &dyn Framing {
        &Jsonl
    }

    fn decode(&self, units: &[Unit], context: DecodeContext<'_>) -> Decoded {
        let mut tree = TreeBuilder::new(context);
        let header = session_header(units);
        let header_time = header.str("time").unwrap_or(EPOCH).to_string();

        for (index, unit) in units.iter().enumerate() {
            let entry = obj_or_empty(Some(&unit.value));
            let uuid = entry.field("uuid").cloned();
            if tree.is_known(index) {
                if let Some(Value::String(_)) = &uuid {
                    let target = tree.known(index).or_else(|| tree.parent_of(entry.field("parentUuid")));
                    tree.alias(uuid.as_ref(), target);
                }
                continue;
            }
            let time = iso_time(entry.field("timestamp"), &header_time);
            let preferred = entry.nonempty("uuid").map_or_else(|| format!("claude-line-{}", index + 1), str::to_string);
            let id = tree.take_id(&preferred);
            // Entries without a parent link (queue operations, snapshots) hang off the latest record.
            let parent_id = if entry.has("parentUuid") { tree.parent_of(entry.field("parentUuid")) } else { tree.last.clone() };
            let node = Node { id: id.clone(), parent_id: parent_id.clone(), time: time.clone() };
            let custom = |tree: &mut TreeBuilder<'_>, name: &str| {
                tree.alias(uuid.as_ref(), Some(id.clone()));
                tree.push(node.record("custom").set("namespace", AGENT).set("name", name).build(), Some(native(unit)));
            };

            match entry.str("type") {
                Some("user") => {
                    let records = user_records(&entry, &node, &mut tree);
                    if records.is_empty() {
                        custom(&mut tree, "user");
                        continue;
                    }
                    tree.alias(uuid.as_ref(), Some(records.last().map(|r| r.id().to_string()).unwrap_or_default()));
                    let first = records[0].id().to_string();
                    for (i, record) in records.into_iter().enumerate() {
                        let n = if i == 0 { native(unit) } else { native_of_shared(&first, AGENT, FORMAT) };
                        tree.push(record, Some(n));
                    }
                }
                Some("assistant") => match assistant_body(&entry, &tree) {
                    Some(body) => {
                        tree.alias(uuid.as_ref(), Some(id.clone()));
                        tree.push(node.record("message").spread(&body).build(), Some(native(unit)));
                    }
                    None => custom(&mut tree, "assistant"),
                },
                Some(kind @ ("summary" | "custom-title" | "ai-title")) => {
                    let title = ["summary", "customTitle", "aiTitle", "title"].into_iter().find_map(|k| entry.str(k));
                    match title {
                        Some(title) => {
                            tree.alias(uuid.as_ref(), parent_id.clone());
                            let record = Obj::new()
                                .set("type", "metadata")
                                .set("id", id.as_str())
                                .set("time", time.as_str())
                                .set("title", title)
                                .build();
                            tree.push(record, Some(native(unit)));
                        }
                        None => custom(&mut tree, kind),
                    }
                }
                Some("last-prompt") => match tree.resolve(entry.field("leafUuid")) {
                    Some(target) => {
                        let record = Obj::new()
                            .set("type", "leaf")
                            .set("id", id.as_str())
                            .set("time", time.as_str())
                            .set("targetId", target)
                            .set("reason", "navigate")
                            .build();
                        tree.push(record, Some(native(unit)));
                    }
                    None => custom(&mut tree, "last-prompt"),
                },
                Some("file-history-snapshot") => {
                    tree.alias(uuid.as_ref(), Some(id.clone()));
                    tree.push(node.record("checkpoint").opt("snapshot", entry.str("messageId")).build(), Some(native(unit)));
                }
                Some("system") => custom(&mut tree, &entry.str("subtype").map_or_else(|| "system".to_string(), |s| format!("system:{s}"))),
                Some("attachment") => {
                    let name = entry
                        .obj("attachment")
                        .and_then(|a| a.str("type"))
                        .map_or_else(|| "attachment".to_string(), |t| format!("attachment:{t}"));
                    custom(&mut tree, &name);
                }
                other => custom(&mut tree, other.unwrap_or("unparsed")),
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
        let mut out = vec![Obj::new().set("type", "atxf").set("transcript", carried_value(transcript)).value()];
        out.extend(values);
        out
    }

    fn detach(&self, units: &[Unit]) -> Option<(Value, Vec<Unit>)> {
        let index = units.iter().position(|u| u.value.is("type", "atxf") && u.value.obj("transcript").is_some())?;
        let transcript = units[index].value.field("transcript")?.clone();
        let rest = units.iter().enumerate().filter(|(i, _)| *i != index).map(|(_, u)| u.clone()).collect();
        Some((transcript, rest))
    }
}

fn session_header(units: &[Unit]) -> Map {
    let entries: Vec<&Map> = units.iter().filter_map(|u| u.value.as_object()).collect();
    let empty = Map::new();
    let first = entries.iter().copied().find(|e| e.str("sessionId").is_some()).unwrap_or(&empty);
    let with_cwd = entries.iter().find(|e| e.str("cwd").is_some());
    let with_time = entries.iter().find(|e| !iso_time(e.field("timestamp"), "").is_empty());
    let with_branch = entries.iter().find(|e| e.str("gitBranch").is_some());
    let workspace = (with_cwd.is_some() || with_branch.is_some()).then(|| {
        Obj::new()
            .opt("cwd", with_cwd.and_then(|e| e.field("cwd")).cloned())
            .opt("vcs", with_branch.map(|e| Obj::new().set("type", "git").set("branch", e["gitBranch"].clone())))
    });
    Obj::new()
        .set("type", "transcript")
        .set("atxf", "0.1")
        .set("id", first.nonempty("sessionId").unwrap_or("claude-code-session"))
        .set("time", iso_time(with_time.and_then(|e| e.field("timestamp")), EPOCH))
        .set(
            "source",
            Obj::new()
                .set("agent", AGENT)
                .set("format", FORMAT)
                .opt("version", first.str("version"))
                .opt("sessionId", first.str("sessionId")),
        )
        .opt("workspace", workspace)
        .set(
            "fidelity",
            Obj::new().set("topology", "tree").set("instructions", "none").set("tools", "none").set("native", "all").set("ids", "stable"),
        )
        .build()
}

/// A user entry: a prompt, tool results (one ATXF message each), or a compaction summary.
fn user_records(entry: &Map, node: &Node, tree: &mut TreeBuilder<'_>) -> Vec<Map> {
    let Some(message) = entry.obj("message") else { return vec![] };
    if entry.bool("isCompactSummary") == Some(true) {
        // Claude Code starts a compacted context at a new root (the compact boundary). A summary below a message
        // does not cut the context: it is a branch summary.
        let summary = text_blocks(message.field("content"));
        let at_root = match &node.parent_id {
            None => true,
            Some(parent) => tree.type_of(parent) == Some("custom"),
        };
        if at_root {
            return vec![
                node.record("compaction").set("strategy", "summary").set("summary", summary).set("firstKeptId", Value::Null).build(),
            ];
        }
        return vec![node.record("branch_summary").set("fromId", opt_str(node.parent_id.as_deref())).set("summary", summary).build()];
    }
    let display = (entry.bool("isMeta") == Some(true)).then_some(false);
    match message.field("content") {
        Some(Value::String(text)) => {
            return vec![node.record("message").set("role", "user").set("content", text.as_str()).opt("display", display).build()];
        }
        Some(Value::Array(_)) => {}
        _ => return vec![],
    }

    let mut records: Vec<Map> = Vec::new();
    let mut blocks = Vec::new();
    let mut parent_id = node.parent_id.clone();
    for block in message.arr("content").into_iter().flatten() {
        let Some(block) = block.as_object() else { continue };
        if let (true, Some(call)) = (block.is("type", "tool_result"), block.str("tool_use_id")) {
            let owner = tree.tool_call_owner(call, Some(parent_id.as_deref()));
            // ATXF requires a result to sit below its call; one elsewhere stays in native only.
            if owner.is_some_and(|owner| !tree.is_ancestor(&owner, parent_id.as_deref())) {
                continue;
            }
            let id = if records.is_empty() { node.id.clone() } else { tree.take_id(&format!("{}:{call}", node.id)) };
            records.push(
                Obj::new()
                    .set("type", "message")
                    .set("id", id.as_str())
                    .set("parentId", opt_str(parent_id.as_deref()))
                    .set("time", node.time.as_str())
                    .set("role", "tool")
                    .set("toolCallId", call)
                    .set("content", tool_result_content(block.field("content")))
                    .opt("isError", (block.bool("is_error") == Some(true)).then_some(true))
                    .build(),
            );
            parent_id = Some(id);
        } else if let Some(converted) = user_block(block) {
            blocks.push(converted);
        }
    }
    if !blocks.is_empty() {
        let id = if records.is_empty() { node.id.clone() } else { tree.take_id(&format!("{}:text", node.id)) };
        records.push(
            Obj::new()
                .set("type", "message")
                .set("id", id.as_str())
                .set("parentId", opt_str(parent_id.as_deref()))
                .set("time", node.time.as_str())
                .set("role", "user")
                .set("content", Value::Array(blocks))
                .opt("display", display)
                .build(),
        );
    }
    records
}

fn user_block(block: &Map) -> Option<Value> {
    match block.str("type") {
        Some("text") => Some(Obj::new().set("type", "text").set("text", block.str("text")?).value()),
        Some("image") => {
            let source = block.obj("source")?;
            match source.str("type") {
                Some("base64") => Some(
                    Obj::new().set("type", "image").set("mediaType", source.str("media_type")?).opt("data", source.str("data")).value(),
                ),
                Some("url") => Some(Obj::new().set("type", "image").set("mediaType", "image/*").set("uri", source.str("url")?).value()),
                _ => None,
            }
        }
        _ => None,
    }
}

fn tool_result_content(content: Option<&Value>) -> Value {
    match content {
        Some(Value::String(text)) => s(text.as_str()),
        Some(Value::Array(blocks)) => Value::Array(blocks.iter().filter_map(|b| b.as_object().and_then(user_block)).collect()),
        _ => s(""),
    }
}

fn stop_of(reason: &str) -> &'static str {
    match reason {
        "end_turn" | "stop_sequence" => "end",
        "tool_use" => "tool_use",
        "max_tokens" => "max_tokens",
        "refusal" => "refusal",
        _ => "other",
    }
}

fn assistant_body(entry: &Map, tree: &TreeBuilder<'_>) -> Option<Map> {
    let message = entry.obj("message")?;
    let blocks = message.arr("content")?;
    let model = message.str("model");
    let signature = |data: Option<&Value>, kind: &str| match data {
        Some(Value::String(d)) if !d.is_empty() => Some(Value::Array(vec![
            Obj::new().set("provider", "anthropic").opt("model", model).set("kind", kind).set("data", d.as_str()).value(),
        ])),
        _ => None,
    };
    let mut content = Vec::new();
    for block in blocks {
        let Some(block) = block.as_object() else { continue };
        match block.str("type") {
            Some("text") if block.str("text").is_some() => {
                content.push(Obj::new().set("type", "text").set("text", block["text"].clone()).value())
            }
            Some("thinking") if block.str("thinking").is_some() => {
                content.push(
                    Obj::new()
                        .set("type", "reasoning")
                        .set("text", block["thinking"].clone())
                        .opt("replay", signature(block.field("signature"), "signature"))
                        .value(),
                );
            }
            Some("redacted_thinking") => {
                content.push(
                    Obj::new()
                        .set("type", "reasoning")
                        .set("redacted", true)
                        .opt("replay", signature(block.field("data"), "redacted_thinking"))
                        .value(),
                );
            }
            Some("tool_use") => {
                let (Some(id), Some(name)) = (block.str("id"), block.str("name")) else { continue };
                if tree.has_tool_call(id) {
                    continue;
                }
                content.push(
                    Obj::new()
                        .set("type", "tool_call")
                        .set("id", id)
                        .set("name", name)
                        .set("arguments", block.obj("input").cloned().unwrap_or_default())
                        .value(),
                );
            }
            _ => {}
        }
    }
    let stop = message.str("stop_reason").map(stop_of);
    let error = (entry.bool("isApiErrorMessage") == Some(true)).then(|| {
        let text = text_blocks(message.field("content"));
        Obj::new().set("message", if text.is_empty() { "API error".to_string() } else { text })
    });
    Some(
        Obj::new()
            .set("role", "assistant")
            .set("content", Value::Array(content))
            .opt("model", model.map(|m| Obj::new().set("provider", "anthropic").set("id", m)))
            .opt("usage", usage_of(message.field("usage")))
            .opt("stop", stop)
            .opt("rawStop", if stop == Some("other") { message.field("stop_reason").cloned() } else { None })
            .opt("responseId", message.str("id"))
            .opt("error", error)
            .build(),
    )
}

fn usage_of(value: Option<&Value>) -> Option<Value> {
    let value = value?.as_object()?;
    let input = count(value.field("input_tokens"))?;
    let output = count(value.field("output_tokens"))?;
    Some(
        Obj::new()
            .set("input", number(input))
            .set("output", number(output))
            .opt("cacheRead", count(value.field("cache_read_input_tokens")).map(number))
            .opt("cacheWrite", count(value.field("cache_creation_input_tokens")).map(number))
            .value(),
    )
}

/// Claude Code uses UUIDs; ATXF ids map to stable name-based ones.
pub fn uuid_for(id: &str) -> String {
    let h = sha256(&format!("atxf:{id}"));
    let variant = (u32::from_str_radix(&h[16..17], 16).unwrap_or(0) & 0x3) | 0x8;
    format!("{}-{}-5{}-{:x}{}-{}", &h[0..8], &h[8..12], &h[13..16], variant, &h[17..20], &h[20..32])
}

fn claude_stop(stop: Option<&Value>) -> Option<&'static str> {
    Some(match stop.and_then(Value::as_str).unwrap_or("end") {
        "end" | "error" | "aborted" | "other" => "end_turn",
        "tool_use" => "tool_use",
        "max_tokens" => "max_tokens",
        "refusal" => "refusal",
        _ => return None,
    })
}

fn encode(transcript: &Transcript) -> Vec<Encoded> {
    let context = build_context(transcript, &BuildContextOptions::default());
    let header = &transcript.header;
    let times: HashMap<&str, &str> = transcript.records.iter().map(|r| (r.id(), r.time())).collect();
    let session_id =
        or_else(header.obj("source").and_then(|s| s.field("sessionId")), || header.field("id").cloned().unwrap_or(Value::Null));
    let cwd = or_else(header.obj("workspace").and_then(|w| w.field("cwd")), || or_else(context.settings.field("cwd"), || s("/")));
    let mut out = Vec::new();
    let mut used = HashSet::new();
    let mut parent_uuid: Option<String> = None;
    let mut time = header.field("time").cloned().unwrap_or(Value::Null);

    let mut line = |fields: Obj, source: &str| {
        if let Some(t) = times.get(source) {
            time = s(*t);
        }
        let mut uuid = uuid_for(source);
        let mut n = 2;
        while used.contains(&uuid) {
            uuid = uuid_for(&format!("{source}#{n}"));
            n += 1;
        }
        used.insert(uuid.clone());
        let value = Obj::new()
            .set("parentUuid", opt_str(parent_uuid.as_deref()))
            .set("isSidechain", false)
            .spread(&fields.build())
            .set("uuid", uuid.as_str())
            .set("timestamp", time.clone())
            .set("cwd", cwd.clone())
            .set("sessionId", session_id.clone())
            .set("version", "atxf");
        out.push(Encoded { value: value.value(), source: Some(source.to_string()) });
        parent_uuid = Some(uuid);
    };

    for message in &context.messages {
        let body = &message.body;
        let source = message.source_id.as_str();
        if message.kind.is_summary() {
            let content = text_blocks(body.field("content"));
            line(
                Obj::new()
                    .set("type", "user")
                    .set("isCompactSummary", true)
                    .set("message", Obj::new().set("role", "user").set("content", content)),
                source,
            );
            continue;
        }
        match body.str("role").unwrap_or("") {
            role @ ("system" | "user") => {
                let hidden = role == "system"
                    || body.field("display") == Some(&Value::Bool(false))
                    || body.obj("origin").is_some_and(|o| o.field("kind") != Some(&s("human")));
                let fields = Obj::new()
                    .set("type", "user")
                    .opt("isMeta", hidden.then_some(true))
                    .set("message", Obj::new().set("role", "user").set("content", claude_content(body.field("content"))));
                line(fields, source);
            }
            "tool" => {
                let result = Obj::new()
                    .set("type", "tool_result")
                    .opt("tool_use_id", body.field("toolCallId").cloned())
                    .set("content", claude_content(body.field("content")))
                    .opt("is_error", body.field("isError").filter(|v| crate::json::truthy(v)).map(|_| true));
                line(
                    Obj::new()
                        .set("type", "user")
                        .set("message", Obj::new().set("role", "user").set("content", Value::Array(vec![result.value()]))),
                    source,
                );
            }
            "assistant" => {
                let mut content = Vec::new();
                for block in body.arr("content").into_iter().flatten() {
                    match block.str("type") {
                        Some("text") => content.push(Obj::new().set("type", "text").opt("text", block.field("text").cloned()).value()),
                        Some("reasoning") => {
                            let signature = replay_data(block.field("replay"), "signature", Some("anthropic"), false).cloned();
                            let thinking = match block.defined("text") {
                                Some(text) => text.clone(),
                                None => s(block
                                    .arr("summary")
                                    .into_iter()
                                    .flatten()
                                    .map(|v| if v.is_null() { String::new() } else { to_js_string(v) })
                                    .collect::<Vec<_>>()
                                    .join("\n")),
                            };
                            content.push(Obj::new().set("type", "thinking").set("thinking", thinking).opt("signature", signature).value());
                        }
                        Some("tool_call") => {
                            let input = match block.defined("arguments") {
                                Some(args) => args.clone(),
                                None => Obj::new().opt("input", block.field("input").cloned()).value(),
                            };
                            content.push(
                                Obj::new()
                                    .set("type", "tool_use")
                                    .opt("id", block.field("id").cloned())
                                    .opt("name", block.field("name").cloned())
                                    .set("input", input)
                                    .value(),
                            );
                        }
                        Some("image") => {}
                        _ => content.push(Value::Null),
                    }
                }
                let usage = body.obj("usage");
                let n = |key: &str| or_else(usage.and_then(|u| u.field(key)), || number(0.0));
                let model = body.obj("model");
                let message = Obj::new()
                    .set("model", or_else(model.and_then(|m| m.field("id")), || s("unknown")))
                    .set("id", or_else(body.field("responseId"), || s(format!("msg_{source}"))))
                    .set("type", "message")
                    .set("role", "assistant")
                    .set("content", Value::Array(content))
                    .opt("stop_reason", claude_stop(body.field("stop").filter(|v| !v.is_null())))
                    .set(
                        "usage",
                        Obj::new()
                            .set("input_tokens", n("input"))
                            .set("output_tokens", n("output"))
                            .set("cache_read_input_tokens", n("cacheRead"))
                            .set("cache_creation_input_tokens", n("cacheWrite")),
                    );
                line(Obj::new().set("type", "assistant").set("message", message), source);
            }
            _ => {}
        }
    }
    out
}

fn claude_content(content: Option<&Value>) -> Value {
    match content {
        Some(Value::Array(blocks)) => Value::Array(
            blocks
                .iter()
                .map(|block| match block.str("type") {
                    Some("text") => Obj::new().set("type", "text").opt("text", block.field("text").cloned()).value(),
                    Some("image") if block.field("data").is_some() => Obj::new()
                        .set("type", "image")
                        .set(
                            "source",
                            Obj::new()
                                .set("type", "base64")
                                .opt("media_type", block.field("mediaType").cloned())
                                .set("data", block["data"].clone()),
                        )
                        .value(),
                    Some("image") => Obj::new()
                        .set("type", "image")
                        .set("source", Obj::new().set("type", "url").set("url", or_else(block.field("uri"), || s(""))))
                        .value(),
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
