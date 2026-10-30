//! Pi session files (`~/.pi/agent/sessions/**.jsonl`), session version 3, as documented in Pi's
//! `docs/session-format.md` and `docs/message-types.md`.

use std::collections::HashMap;

use super::{Node, obj_or_empty, opt_str, or_else, replay_data, text_blocks};
use crate::codec::{DecodeContext, Decoded, Encoded, FormatSpec, IdAllocator, TreeBuilder, carried_value, mark_id};
use crate::context::{BuildContextOptions, build_context};
use crate::json::{self, Get, Map, Obj, Value, amount, count, entries, number, s, to_js_string};
use crate::native::{Framing, Jsonl, Unit, native_of};
use crate::time::{EPOCH, iso_time, millis_from_iso};
use crate::transcript::{Record, Transcript};

pub struct Pi;

const AGENT: &str = "pi";
const FORMAT: &str = "pi/session-jsonl";

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
                session_header(first, Some(native(&units[0])))
            }
            _ => session_header(&Map::new(), None),
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
            let record = entry_record(entry, index, &mut tree, &fallback_time, has_context);
            if record.kind() == "context" {
                has_context = true;
            }
            tree.push(record, Some(native(unit)));
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
        let header = obj_or_empty(values.next().as_ref());
        let atxf = Obj::new().spread(&obj_or_empty(header.field("atxf"))).set("transcript", carried_value(transcript));
        let mut out = vec![Obj::new().spread(&header).set("atxf", atxf).value()];
        out.extend(values);
        out
    }

    fn detach(&self, units: &[Unit]) -> Option<(Value, Vec<Unit>)> {
        detach_from_atxf_key(units)
    }
}

/// Finds a unit whose `atxf` key carries the transcript, and returns the transcript and the units with the mark
/// left in place. Shared by the formats that carry the transcript on a header line (Pi, Gemini CLI).
pub(super) fn detach_from_atxf_key(units: &[Unit]) -> Option<(Value, Vec<Unit>)> {
    let index = units.iter().position(|u| u.value.obj("atxf").and_then(|a| a.obj("transcript")).is_some())?;
    let value = units[index].value.as_object()?;
    let atxf = value.obj("atxf")?;
    let transcript = atxf.get("transcript")?.clone();
    let mut mark = atxf.clone();
    mark.shift_remove("transcript");
    let mut rest = units.to_vec();
    rest[index] = Unit { value: Obj::new().spread(value).set("atxf", Value::Object(mark)).value(), raw: units[index].raw.clone() };
    Some((transcript, rest))
}

fn session_header(session: &Map, native: Option<Map>) -> Map {
    let id = session.nonempty("id").unwrap_or("pi-session");
    Obj::new()
        .set("type", "transcript")
        .set("atxf", "0.1")
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
        .opt("native", native)
        .build()
}

enum Body {
    Message(Map),
    Context,
}

fn entry_record(entry: &Value, index: usize, tree: &mut TreeBuilder<'_>, fallback_time: &str, has_context: bool) -> Map {
    let e = obj_or_empty(Some(entry));
    let preferred = e.nonempty("id").map_or_else(|| format!("pi-line-{}", index + 1), str::to_string);
    let id = tree.take_id(&preferred);
    let parent_id = tree.parent_of(e.field("parentId"));
    let time = iso_time(e.field("timestamp"), fallback_time);
    let node = Node { id: id.clone(), parent_id: parent_id.clone(), time: time.clone() };
    let native_id = e.field("id").cloned();
    let custom = |tree: &mut TreeBuilder<'_>| {
        tree.alias(native_id.as_ref(), Some(id.clone()));
        node.record("custom").set("namespace", AGENT).set("name", e.str("type").unwrap_or("unparsed")).build()
    };
    let as_tree = |tree: &mut TreeBuilder<'_>, record: Map| {
        tree.alias(native_id.as_ref(), Some(id.clone()));
        record
    };

    match e.str("type") {
        Some("message") => match message_body(e.field("message"), tree) {
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

fn replay(base: &Obj, kind: &str, data: Option<&Value>) -> Option<Value> {
    match data {
        Some(Value::String(d)) if !d.is_empty() => Some(Value::Array(vec![base.clone().set("kind", kind).set("data", d.as_str()).value()])),
        _ => None,
    }
}

/// A Pi message as an ATXF message body; `Context` for a system message; `None` when it has no portable form.
fn message_body(message: Option<&Value>, tree: &TreeBuilder<'_>) -> Option<Body> {
    let message = message?.as_object()?;
    match message.str("role")? {
        "system" => Some(Body::Context),
        "user" => Some(Body::Message(Obj::new().set("role", "user").set("content", user_content(message.field("content"))?).build())),
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
                    .opt("error", message.str("errorMessage").map(|m| Obj::new().set("message", m)))
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
                .set("isError", body.field("isError") == Some(&Value::Bool(true)))
                .set("timestamp", timestamp)
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
            let usage = body.obj("usage");
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
            let model = body.obj("model");
            Obj::new()
                .set("role", "assistant")
                .set("content", Value::Array(content))
                .set("api", or_else(model.and_then(|m| m.field("api")), || s("unknown")))
                .set("provider", or_else(model.and_then(|m| m.field("provider")), || s("unknown")))
                .set("model", or_else(model.and_then(|m| m.field("id")), || s("unknown")))
                .opt("responseId", body.field("responseId").cloned())
                .set(
                    "usage",
                    Obj::new()
                        .set("input", n(usage, "input"))
                        .set("output", n(usage, "output"))
                        .set("cacheRead", n(usage, "cacheRead"))
                        .set("cacheWrite", n(usage, "cacheWrite"))
                        .set("totalTokens", total)
                        .set(
                            "cost",
                            Obj::new()
                                .set("input", n(cost, "input"))
                                .set("output", n(cost, "output"))
                                .set("cacheRead", n(cost, "cacheRead"))
                                .set("cacheWrite", n(cost, "cacheWrite"))
                                .set("total", n(cost, "total")),
                        ),
                )
                .opt("stopReason", pi_stop(body.field("stop").filter(|v| !v.is_null())))
                .opt("rawStopReason", body.field("rawStop").cloned())
                .opt("errorMessage", body.obj("error").and_then(|e| e.field("message")).cloned())
                .set("timestamp", timestamp)
                .value()
        }
        _ => Value::Null,
    }
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
