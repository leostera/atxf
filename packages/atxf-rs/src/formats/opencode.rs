//! OpenCode session exports (`opencode session export`): `JSON.stringify({info, messages}, null, 2)` plus a
//! newline, following `SessionTransfer.Data` in `packages/schema` of OpenCode v2.

use std::collections::HashMap;

use super::{Node, obj_or_empty, opt_str, or_else};
use crate::codec::{DecodeContext, Decoded, Encoded, FormatSpec, IdAllocator, TreeBuilder, carried_value, mark_id};
use crate::context::{BuildContextOptions, build_context};
use crate::equivalence::content_text;
use crate::json::{Get, Map, Obj, Value, amount, count, number, s};
use crate::native::{Framing, JsonDocument, Unit, native_of, native_of_shared};
use crate::time::{EPOCH, iso_time, millis_from_iso};
use crate::transcript::{Record, Transcript};

pub struct OpenCode;

const AGENT: &str = "opencode";
const FORMAT: &str = "opencode/session-export-json";

static FRAMING: JsonDocument = JsonDocument { items: "messages", indent: "  ", eol: "\n" };

fn native(unit: &Unit) -> Map {
    native_of(&[unit], AGENT, FORMAT, &FRAMING)
}

impl FormatSpec for OpenCode {
    const AGENT: &'static str = AGENT;
    const FORMAT: &'static str = FORMAT;

    fn framing(&self) -> &dyn Framing {
        &FRAMING
    }

    fn decode(&self, units: &[Unit], context: DecodeContext<'_>) -> Decoded {
        let mut tree = TreeBuilder::new(context);
        let mut start = 0;
        let mut header = session_header(&Map::new(), None);
        if let Some(first) = units.first() {
            if !tree.is_known(0) {
                header = session_header(first.value.obj("info").unwrap_or(&Map::new()), Some(native(first)));
            }
            start = 1;
        }
        let header_time = header.str("time").unwrap_or(EPOCH).to_string();
        let mut turns = 0u64;

        for (index, unit) in units.iter().enumerate().skip(start) {
            if tree.is_known(index) {
                if let Some(known) = tree.known(index).filter(|k| !k.is_empty()) {
                    tree.last = Some(known);
                }
                continue;
            }
            let message = obj_or_empty(Some(&unit.value));
            let preferred = message.nonempty("id").map_or_else(|| format!("opencode-{index}"), str::to_string);
            let id = tree.take_id(&preferred);
            let time = iso_time(message.obj("time").and_then(|t| t.field("created")), &header_time);
            let node = Node { id, parent_id: tree.last.clone(), time };
            let push = |tree: &mut TreeBuilder<'_>, record: Map| {
                tree.push(record, Some(native(unit)));
            };
            let custom = |tree: &mut TreeBuilder<'_>, name: &str| {
                push(tree, node.record("custom").set("namespace", AGENT).set("name", name).build())
            };
            let text = message.str("text");

            match message.str("type") {
                Some("user") => match text {
                    Some(text) => push(
                        &mut tree,
                        node.record("message").set("role", "user").set("content", user_content(text, message.field("files"))).build(),
                    ),
                    None => custom(&mut tree, "user"),
                },
                Some("synthetic") => match text {
                    Some(text) => push(
                        &mut tree,
                        node.record("message")
                            .set("role", "user")
                            .set("content", text)
                            .set("origin", Obj::new().set("kind", "synthetic"))
                            .build(),
                    ),
                    None => custom(&mut tree, "synthetic"),
                },
                Some("system") => match text {
                    Some(text) => push(&mut tree, node.record("message").set("role", "system").set("content", text).build()),
                    None => custom(&mut tree, "system"),
                },
                Some("skill") => match text {
                    Some(text) => push(
                        &mut tree,
                        node.record("message")
                            .set("role", "user")
                            .set("content", text)
                            .set("origin", Obj::new().set("kind", "extension").opt("name", message.str("name")))
                            .build(),
                    ),
                    None => custom(&mut tree, "skill"),
                },
                Some("shell") => match message.str("command") {
                    Some(command) => {
                        let content = format!("$ {command}\n{}", message.str("output").unwrap_or(""));
                        push(
                            &mut tree,
                            node.record("message")
                                .set("role", "user")
                                .set("content", content)
                                .set("origin", Obj::new().set("kind", "command").set("name", "shell"))
                                .build(),
                        );
                    }
                    None => custom(&mut tree, "shell"),
                },
                Some("assistant") => {
                    let records = assistant_records(&message, &node, &mut tree);
                    if records.is_empty() {
                        custom(&mut tree, "assistant");
                    } else {
                        let first = records[0].id().to_string();
                        for (i, record) in records.into_iter().enumerate() {
                            let n = if i == 0 { native(unit) } else { native_of_shared(&first, AGENT, FORMAT) };
                            tree.push(record, Some(n));
                        }
                    }
                }
                Some("compaction") => match (message.is("status", "completed"), message.str("summary")) {
                    (true, Some(summary)) => {
                        let reason = message.str("reason").filter(|r| *r == "auto" || *r == "manual");
                        push(
                            &mut tree,
                            node.record("compaction")
                                .set("strategy", "summary")
                                .set("summary", summary)
                                .set("firstKeptId", Value::Null)
                                .opt("reason", reason)
                                .build(),
                        );
                    }
                    _ => custom(&mut tree, &format!("compaction:{}", message.str("status").unwrap_or("unknown"))),
                },
                Some("agent-switched") => match message.str("agent") {
                    Some(agent) => push(&mut tree, node.record("settings").set("agent", agent).build()),
                    None => custom(&mut tree, "agent-switched"),
                },
                Some("model-switched") => match model_of(message.field("model")) {
                    Some(model) => push(&mut tree, node.record("settings").set("model", model).build()),
                    None => custom(&mut tree, "model-switched"),
                },
                Some("location-switched") => match message.obj("location").and_then(|l| l.str("directory")) {
                    Some(dir) => push(&mut tree, node.record("settings").set("cwd", dir).build()),
                    None => custom(&mut tree, "location-switched"),
                },
                Some("idle") => {
                    turns += 1;
                    let outcome = message.str("outcome").filter(|o| matches!(*o, "succeeded" | "failed" | "interrupted"));
                    push(
                        &mut tree,
                        node.record("turn").set("phase", "end").set("turnId", format!("turn-{turns}")).opt("outcome", outcome).build(),
                    );
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
        let v = obj_or_empty(Some(&value));
        let atxf = Obj::new().set("id", opt_str(source));
        if let Some(info) = v.obj("info") {
            let metadata = Obj::new().spread(&obj_or_empty(info.field("metadata"))).set("atxf", atxf);
            return Obj::new().spread(&v).set("info", Obj::new().spread(info).set("metadata", metadata)).value();
        }
        let metadata = Obj::new().spread(&obj_or_empty(v.field("metadata"))).set("atxf", atxf);
        Obj::new().spread(&v).set("metadata", metadata).value()
    }

    fn mark_of(&self, value: &Value) -> Option<Option<String>> {
        let value = value.as_object()?;
        let metadata = match value.obj("info") {
            Some(info) => info.field("metadata"),
            None => value.field("metadata"),
        };
        mark_id(metadata.and_then(|m| m.obj("atxf")))
    }

    fn attach(&self, values: Vec<Value>, transcript: &Transcript) -> Vec<Value> {
        let mut values = values.into_iter();
        let head = obj_or_empty(values.next().as_ref());
        let info = obj_or_empty(head.field("info"));
        let metadata = obj_or_empty(info.field("metadata"));
        let atxf = Obj::new().spread(&obj_or_empty(metadata.field("atxf"))).set("transcript", carried_value(transcript));
        let info = Obj::new().spread(&info).set("metadata", Obj::new().spread(&metadata).set("atxf", atxf));
        let mut out = vec![Obj::new().spread(&head).set("info", info).value()];
        out.extend(values);
        out
    }

    fn detach(&self, units: &[Unit]) -> Option<(Value, Vec<Unit>)> {
        let head = units.first()?.value.as_object()?;
        let info = head.obj("info")?;
        let metadata = info.obj("metadata")?;
        let atxf = metadata.obj("atxf")?;
        atxf.obj("transcript")?;
        let transcript = atxf["transcript"].clone();
        let mut mark = atxf.clone();
        mark.shift_remove("transcript");
        let value = Obj::new()
            .spread(head)
            .set("info", Obj::new().spread(info).set("metadata", Obj::new().spread(metadata).set("atxf", Value::Object(mark))))
            .value();
        let mut rest = units.to_vec();
        rest[0] = Unit { value, raw: String::new() };
        Some((transcript, rest))
    }
}

fn model_of(value: Option<&Value>) -> Option<Map> {
    let model = value?.as_object()?;
    Some(Obj::new().set("provider", model.str("providerID")?).set("id", model.str("id")?).opt("variant", model.str("variant")).build())
}

fn session_header(info: &Map, native: Option<Map>) -> Map {
    let time = obj_or_empty(info.field("time"));
    let directory = info.obj("location").and_then(|l| l.str("directory")).filter(|d| !d.is_empty());
    let parent = match (info.str("parentID"), info.obj("fork").and_then(|f| f.str("sessionID"))) {
        (Some(parent), _) => Some(Obj::new().set("transcriptId", parent).set("relation", "subagent")),
        (None, Some(fork)) => Some(Obj::new().set("transcriptId", fork).set("relation", "fork")),
        _ => None,
    };
    Obj::new()
        .set("type", "transcript")
        .set("atxf", "0.1")
        .set("id", info.nonempty("id").unwrap_or("opencode-session"))
        .set("time", iso_time(time.field("created"), EPOCH))
        .opt("title", info.str("title"))
        .set("source", Obj::new().set("agent", AGENT).set("format", FORMAT).opt("sessionId", info.str("id")))
        .opt("workspace", directory.map(|d| Obj::new().set("cwd", d)))
        .opt("parent", parent)
        .set(
            "fidelity",
            Obj::new().set("topology", "linear").set("toolLifecycle", true).set("turns", true).set("native", "all").set("ids", "stable"),
        )
        .opt("native", native)
        .build()
}

fn user_content(text: &str, files: Option<&Value>) -> Value {
    let Some(files) = files.and_then(Value::as_array).filter(|f| !f.is_empty()) else { return s(text) };
    let mut blocks = Vec::new();
    if !text.is_empty() {
        blocks.push(Obj::new().set("type", "text").set("text", text).value());
    }
    for file in files {
        let Some(mime) = file.str("mime").filter(|_| file.is_object()) else { continue };
        if let (true, Some(data)) = (mime.starts_with("image/"), file.str("data")) {
            blocks.push(Obj::new().set("type", "image").set("mediaType", mime).set("data", data).value());
        } else {
            let name = file.str("name");
            let uri = file.str("uri").map_or_else(|| format!("file:{}", name.unwrap_or("attachment")), str::to_string);
            blocks.push(Obj::new().set("type", "resource").set("uri", uri).opt("name", name).set("mediaType", mime).value());
        }
    }
    Value::Array(blocks)
}

fn stop_of(finish: &str) -> &'static str {
    match finish {
        "stop" => "end",
        "tool-calls" => "tool_use",
        "length" => "max_tokens",
        "content-filter" => "refusal",
        "error" => "error",
        _ => "other",
    }
}

/// An assistant step: one assistant message, then one tool message for each settled tool call.
fn assistant_records(message: &Map, node: &Node, tree: &mut TreeBuilder<'_>) -> Vec<Map> {
    let Some(parts) = message.arr("content") else { return vec![] };
    let model = model_of(message.field("model"));
    let mut content = Vec::new();
    struct Settled {
        call: String,
        name: String,
        content: Value,
        error: bool,
        time: String,
    }
    let mut results: Vec<Settled> = Vec::new();
    for part in parts {
        let Some(part) = part.as_object() else { continue };
        match part.str("type") {
            Some("text") if part.str("text").is_some() => {
                content.push(Obj::new().set("type", "text").set("text", part["text"].clone()).value())
            }
            Some("reasoning") if part.str("text").is_some() => {
                let replay = match (part.obj("native"), &model) {
                    (Some(native), Some(model)) => Some(Value::Array(vec![
                        Obj::new()
                            .set("provider", model["provider"].clone())
                            .set("kind", "native")
                            .set("data", Value::Object(native.clone()))
                            .value(),
                    ])),
                    _ => None,
                };
                content.push(Obj::new().set("type", "reasoning").set("text", part["text"].clone()).opt("replay", replay).value());
            }
            Some("tool") => {
                let (Some(id), Some(name)) = (part.str("id"), part.str("name")) else { continue };
                if tree.has_tool_call(id) {
                    continue;
                }
                let state = obj_or_empty(part.field("state"));
                content.push(match state.obj("input") {
                    Some(input) => Obj::new()
                        .set("type", "tool_call")
                        .set("id", id)
                        .set("name", name)
                        .set("arguments", Value::Object(input.clone()))
                        .value(),
                    None => Obj::new()
                        .set("type", "tool_call")
                        .set("id", id)
                        .set("name", name)
                        .set("input", state.str("input").unwrap_or(""))
                        .value(),
                });
                if state.is("status", "completed") || state.is("status", "error") {
                    let from_content = state.arr("content").map(|c| tool_content(c));
                    let error_text = state.obj("error").and_then(|e| e.str("message")).unwrap_or("");
                    let time_value = part.obj("time").and_then(|t| t.defined("completed").or_else(|| t.field("created")));
                    results.push(Settled {
                        call: id.to_string(),
                        name: name.to_string(),
                        content: from_content.unwrap_or_else(|| s(error_text)),
                        error: state.is("status", "error"),
                        time: iso_time(time_value, &node.time),
                    });
                }
            }
            _ => {}
        }
    }
    let tokens = obj_or_empty(message.field("tokens"));
    let cache = tokens.obj("cache");
    let cost = amount(message.field("cost")).map(|c| Obj::new().set("total", number(c)).set("currency", "USD"));
    let usage = match (count(tokens.field("input")), count(tokens.field("output"))) {
        (Some(input), Some(output)) => Some(
            Obj::new()
                .set("input", number(input))
                .set("output", number(output))
                .opt("reasoning", count(tokens.field("reasoning")).map(number))
                .opt("cacheRead", cache.and_then(|c| count(c.field("read"))).map(number))
                .opt("cacheWrite", cache.and_then(|c| count(c.field("write"))).map(number))
                .opt("cost", cost),
        ),
        _ => None,
    };
    let stop = message.str("finish").map(stop_of);
    let raw_stop = match message.str("rawFinish") {
        Some(raw) => Some(Value::from(raw)),
        None if stop == Some("other") => message.field("finish").cloned(),
        None => None,
    };
    let error = message.obj("error").and_then(|e| e.str("message").map(|m| Obj::new().set("message", m).opt("code", e.str("type"))));
    let assistant = node
        .record("message")
        .set("role", "assistant")
        .set("content", Value::Array(content))
        .opt("model", model)
        .opt("usage", usage)
        .opt("stop", stop)
        .opt("rawStop", raw_stop)
        .opt("error", error)
        .build();
    let mut records = vec![assistant];
    let mut parent_id = node.id.clone();
    for result in results {
        let id = tree.take_id(&format!("{}:{}", node.id, result.call));
        records.push(
            Obj::new()
                .set("type", "message")
                .set("id", id.as_str())
                .set("parentId", parent_id.as_str())
                .set("time", result.time)
                .set("role", "tool")
                .set("toolCallId", result.call)
                .set("toolName", result.name)
                .set("content", result.content)
                .opt("isError", result.error.then_some(true))
                .build(),
        );
        parent_id = id;
    }
    records
}

fn tool_content(content: &[Value]) -> Value {
    let mut blocks = Vec::new();
    for item in content {
        let Some(item) = item.as_object() else { continue };
        match item.str("type") {
            Some("text") if item.str("text").is_some() => {
                blocks.push(Obj::new().set("type", "text").set("text", item["text"].clone()).value())
            }
            Some("file") if item.str("uri").is_some() => {
                blocks.push(
                    Obj::new()
                        .set("type", "resource")
                        .set("uri", item["uri"].clone())
                        .opt("mediaType", item.str("mime"))
                        .opt("name", item.str("name"))
                        .value(),
                );
            }
            _ => {}
        }
    }
    Value::Array(blocks)
}

fn finish(stop: Option<&Value>) -> Option<&'static str> {
    Some(match stop.and_then(Value::as_str).unwrap_or("end") {
        "end" => "stop",
        "tool_use" => "tool-calls",
        "max_tokens" => "length",
        "refusal" => "content-filter",
        "error" => "error",
        "aborted" | "other" => "unknown",
        _ => return None,
    })
}

fn encode(transcript: &Transcript) -> Vec<Encoded> {
    let context = build_context(transcript, &BuildContextOptions::default());
    let header = &transcript.header;
    let header_time = header.str("time").unwrap_or("");
    let times: HashMap<&str, &str> = transcript.records.iter().map(|r| (r.id(), r.time())).collect();
    let mut ids = IdAllocator::default();
    let mut msg_id = |source: &str| if source.starts_with("msg_") { ids.take(source) } else { ids.take(&format!("msg_{source}")) };
    let mut results: Vec<(String, &Map)> = Vec::new();
    for message in &context.messages {
        if let (true, Some(call)) = (message.body.is("role", "tool"), message.body.str("toolCallId"))
            && !results.iter().any(|(k, _)| k == call)
        {
            results.push((call.to_string(), &message.body));
        }
    }
    let created = |source: &str| number(millis_from_iso(times.get(source).copied().unwrap_or(header_time)));
    let zero_tokens =
        || Obj::new().set("input", 0).set("output", 0).set("reasoning", 0).set("cache", Obj::new().set("read", 0).set("write", 0));

    let last_time = transcript.records.last().map_or(header_time, |r| r.time());
    let info = Obj::new()
        .set("id", or_else(header.obj("source").and_then(|s| s.field("sessionId")), || header.field("id").cloned().unwrap_or(Value::Null)))
        .set("projectID", "atxf")
        .opt("title", header.field("title").cloned())
        .set("cost", 0)
        .set("tokens", zero_tokens())
        .set("time", Obj::new().set("created", number(millis_from_iso(header_time))).set("updated", number(millis_from_iso(last_time))))
        .set(
            "location",
            Obj::new().set(
                "directory",
                or_else(header.obj("workspace").and_then(|w| w.field("cwd")), || or_else(context.settings.field("cwd"), || s("/"))),
            ),
        );
    let mut out = vec![Encoded { value: Obj::new().set("info", info).value(), source: None }];
    if let Some(model) = context.model() {
        let value = Obj::new()
            .set("id", msg_id("atxf_model"))
            .set("type", "model-switched")
            .set(
                "model",
                Obj::new()
                    .set("id", model.field("id").cloned().unwrap_or(Value::Null))
                    .set("providerID", model.field("provider").cloned().unwrap_or(Value::Null)),
            )
            .set("time", Obj::new().set("created", number(millis_from_iso(header_time))));
        out.push(Encoded { value: value.value(), source: None });
    }

    for (index, message) in context.messages.iter().enumerate() {
        let body = &message.body;
        let source = message.source_id.as_str();
        let base = Obj::new().set("id", msg_id(source)).set("time", Obj::new().set("created", created(source)));
        let push = |out: &mut Vec<Encoded>, value: Obj| out.push(Encoded { value: value.value(), source: Some(source.to_string()) });
        let user = |text: String| {
            base.clone()
                .set("type", "user")
                .set("text", text)
                .set("files", Value::Array(vec![]))
                .set("agents", Value::Array(vec![]))
                .set("skills", Value::Array(vec![]))
        };
        if message.kind.is_summary() {
            // A compaction starts the context; a summary later on can only be a user message.
            let summary = content_text(body.field("content"));
            let value = if index == 0 {
                base.clone().set("type", "compaction").set("status", "completed").set("reason", "auto").set("summary", summary)
            } else {
                user(summary)
            };
            push(&mut out, value);
            continue;
        }
        match body.str("role").unwrap_or("") {
            "system" => push(&mut out, base.clone().set("type", "system").set("text", content_text(body.field("content")))),
            "user" => {
                let hidden = body.field("display") == Some(&Value::Bool(false))
                    || body.obj("origin").is_some_and(|o| o.field("kind") != Some(&s("human")));
                let text = content_text(body.field("content"));
                push(&mut out, if hidden { base.clone().set("type", "synthetic").set("text", text) } else { user(text) });
            }
            "assistant" => {
                let mut content = Vec::new();
                for block in body.arr("content").into_iter().flatten() {
                    match block.str("type") {
                        Some("text") => content.push(Obj::new().set("type", "text").opt("text", block.field("text").cloned()).value()),
                        Some("reasoning") => {
                            let text = match block.defined("text") {
                                Some(t) => t.clone(),
                                None => s(block
                                    .arr("summary")
                                    .into_iter()
                                    .flatten()
                                    .map(|v| if v.is_null() { String::new() } else { crate::json::to_js_string(v) })
                                    .collect::<Vec<_>>()
                                    .join("\n")),
                            };
                            content.push(Obj::new().set("type", "reasoning").set("text", text).value());
                        }
                        Some("image") => {}
                        Some("tool_call") => {
                            let input = match block.defined("arguments") {
                                Some(args) => args.clone(),
                                None => Obj::new().set("input", or_else(block.field("input"), || s(""))).value(),
                            };
                            let result = block.str("id").and_then(|id| results.iter().find(|(k, _)| k == id)).map(|(_, r)| *r);
                            let result_text = result.map_or_else(String::new, |r| content_text(r.field("content")));
                            let state = match result {
                                None => Obj::new().set("status", "running").set("input", input).set("metadata", Obj::new()),
                                Some(r) if r.field("isError").is_some_and(crate::json::truthy) => Obj::new()
                                    .set("status", "error")
                                    .set("input", input)
                                    .set("error", Obj::new().set("type", "tool").set("message", result_text.as_str()))
                                    .set(
                                        "content",
                                        Value::Array(vec![Obj::new().set("type", "text").set("text", result_text.as_str()).value()]),
                                    ),
                                Some(_) => Obj::new().set("status", "completed").set("input", input).set(
                                    "content",
                                    Value::Array(vec![Obj::new().set("type", "text").set("text", result_text.as_str()).value()]),
                                ),
                            };
                            content.push(
                                Obj::new()
                                    .set("type", "tool")
                                    .opt("id", block.field("id").cloned())
                                    .opt("name", block.field("name").cloned())
                                    .set("state", state)
                                    .set("time", Obj::new().set("created", created(source)))
                                    .value(),
                            );
                        }
                        _ => content.push(Value::Null),
                    }
                }
                let usage = body.obj("usage");
                let model = body.obj("model");
                let tokens = usage.map(|u| {
                    Obj::new()
                        .opt("input", u.field("input").cloned())
                        .opt("output", u.field("output").cloned())
                        .set("reasoning", or_else(u.field("reasoning"), || number(0.0)))
                        .set(
                            "cache",
                            Obj::new()
                                .set("read", or_else(u.field("cacheRead"), || number(0.0)))
                                .set("write", or_else(u.field("cacheWrite"), || number(0.0))),
                        )
                });
                let value = base
                    .clone()
                    .set("type", "assistant")
                    .set("agent", "build")
                    .set(
                        "model",
                        Obj::new()
                            .set("id", or_else(model.and_then(|m| m.field("id")), || s("unknown")))
                            .set("providerID", or_else(model.and_then(|m| m.field("provider")), || s("unknown"))),
                    )
                    .set("content", Value::Array(content))
                    .opt("finish", finish(body.field("stop").filter(|v| !v.is_null())))
                    .opt("cost", usage.and_then(|u| u.obj("cost")).and_then(|c| c.field("total")).cloned())
                    .opt("tokens", tokens);
                push(&mut out, value);
            }
            _ => {}
        }
    }
    out
}
