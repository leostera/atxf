//! Codex rollout files (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), following `codex-rs/history` and
//! `codex-rs/protocol` at commit 4bc746c. Each line is `{timestamp, ordinal?, type, payload}`.

use std::collections::HashMap;

use super::{Node, obj_or_empty, opt_str, or_else, replay_data};
use crate::codec::{DecodeContext, Decoded, Encoded, FormatSpec, TreeBuilder, carried_value, mark_id};
use crate::context::{BuildContextOptions, build_context};
use crate::equivalence::content_text;
use crate::json::{self, Get, Map, Obj, Value, count, number, s, to_js_string};
use crate::native::{Framing, Jsonl, Unit, native_of};
use crate::time::{EPOCH, iso_time};
use crate::transcript::{Record, Transcript};

pub struct Codex;

const AGENT: &str = "codex";
const FORMAT: &str = "codex/rollout-jsonl";

fn native(unit: &Unit) -> Map {
    native_of(&[unit], AGENT, FORMAT, &Jsonl)
}

impl FormatSpec for Codex {
    const AGENT: &'static str = AGENT;
    const FORMAT: &'static str = FORMAT;

    fn framing(&self) -> &dyn Framing {
        &Jsonl
    }

    fn decode(&self, units: &[Unit], context: DecodeContext<'_>) -> Decoded {
        let mut tree = TreeBuilder::new(context);
        let mut start = 0;
        let first = units.first().map(|u| &u.value);
        let header = match first {
            Some(Value::Object(f)) if f.is("type", "session_meta") && f.obj("payload").is_some() && !tree.is_known(0) => {
                start = 1;
                session_header(f, Some(native(&units[0])))
            }
            _ => session_header(&Map::new(), None),
        };
        let header_time = header.str("time").unwrap_or(EPOCH).to_string();
        let mut provider = first.and_then(|f| f.obj("payload")).and_then(|p| p.str("model_provider")).unwrap_or("openai").to_string();
        let mut turns = 0u64;

        for (index, unit) in units.iter().enumerate().skip(start) {
            if tree.is_known(index) {
                if let Some(known) = tree.known(index).filter(|k| !k.is_empty()) {
                    tree.last = Some(known);
                }
                continue;
            }
            let line = obj_or_empty(Some(&unit.value));
            let payload = obj_or_empty(line.field("payload"));
            let id = tree.take_id(&format!("codex-{}", index + 1));
            let node = Node { id, parent_id: tree.last.clone(), time: iso_time(line.field("timestamp"), &header_time) };
            let push = |tree: &mut TreeBuilder<'_>, record: Map| {
                tree.push(record, Some(native(unit)));
            };
            let custom = |tree: &mut TreeBuilder<'_>, name: &str| {
                push(tree, node.record("custom").set("namespace", AGENT).set("name", name).build())
            };

            match line.str("type") {
                Some("response_item") => match response_item(&payload, Some(&tree)) {
                    Some(body) => push(&mut tree, node.record("message").spread(&body).build()),
                    None => custom(&mut tree, &format!("response_item:{}", payload.str("type").unwrap_or("unknown"))),
                },
                Some("turn_context") => {
                    if payload.str("model").is_some()
                        && let Some(p) = payload.str("model_provider")
                    {
                        provider = p.to_string();
                    }
                    let policy = (payload.field("approval_policy").is_some() || payload.field("sandbox_policy").is_some()).then(|| {
                        Obj::new()
                            .opt("approval", payload.field("approval_policy").cloned())
                            .opt("sandbox", payload.field("sandbox_policy").cloned())
                    });
                    let record = node
                        .record("settings")
                        .opt("model", payload.str("model").map(|m| Obj::new().set("provider", provider.as_str()).set("id", m)))
                        .opt("reasoningEffort", payload.str("effort"))
                        .opt("cwd", payload.str("cwd"))
                        .opt("policy", policy)
                        .build();
                    push(&mut tree, record);
                }
                Some("compacted") => {
                    let replacement: Option<Vec<Value>> = payload.arr("replacement_history").map(|items| {
                        items
                            .iter()
                            .filter_map(|item| {
                                let item = item.as_object()?;
                                let inner = item.obj("item").unwrap_or(item);
                                response_item(inner, None).filter(|b| !b.is("role", "tool")).map(Value::Object)
                            })
                            .collect()
                    });
                    match (replacement, payload.str("message")) {
                        (Some(r), _) if !r.is_empty() => push(
                            &mut tree,
                            node.record("compaction").set("strategy", "replace").set("replacement", Value::Array(r)).build(),
                        ),
                        (_, Some(message)) => push(
                            &mut tree,
                            node.record("compaction")
                                .set("strategy", "summary")
                                .set("summary", message)
                                .set("firstKeptId", Value::Null)
                                .build(),
                        ),
                        _ => custom(&mut tree, "compacted"),
                    }
                }
                Some("event_msg") => {
                    let event = payload.str("type").unwrap_or("unknown");
                    match event {
                        "task_started" | "turn_started" => {
                            let turn_id = payload.str("turn_id").map_or_else(
                                || {
                                    turns += 1;
                                    format!("turn-{turns}")
                                },
                                str::to_string,
                            );
                            push(&mut tree, node.record("turn").set("phase", "start").set("turnId", turn_id).build());
                        }
                        "task_complete" | "turn_complete" | "turn_aborted" => {
                            let turn_id = payload.str("turn_id").map_or_else(|| format!("turn-{turns}"), str::to_string);
                            let outcome = if event == "turn_aborted" { "interrupted" } else { "succeeded" };
                            push(&mut tree, node.record("turn").set("phase", "end").set("turnId", turn_id).set("outcome", outcome).build());
                        }
                        "token_count" if token_usage(payload.obj("info").and_then(|i| i.field("total_token_usage"))).is_some() => {
                            let usage = token_usage(payload.obj("info").and_then(|i| i.field("total_token_usage"))).unwrap_or(Value::Null);
                            push(
                                &mut tree,
                                node.record("usage").set("kind", "token_count").set("usage", usage).set("cumulative", true).build(),
                            );
                        }
                        _ => custom(&mut tree, &format!("event_msg:{event}")),
                    }
                }
                Some("token_usage_record") => {
                    let source = payload.defined("total_token_usage").or_else(|| payload.defined("usage"));
                    let usage = match source {
                        Some(v) => token_usage(Some(v)),
                        None => token_usage(Some(&Value::Object(payload.clone()))),
                    };
                    match usage {
                        Some(usage) => push(
                            &mut tree,
                            node.record("usage").set("kind", "token_usage_record").set("usage", usage).set("cumulative", true).build(),
                        ),
                        None => custom(&mut tree, "token_usage_record"),
                    }
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
        let mut values = values.into_iter();
        let meta = values.next().unwrap_or(Value::Null);
        let carrier = Obj::new()
            .opt("timestamp", meta.field("timestamp").cloned())
            .set("type", "atxf")
            .set("payload", Obj::new().set("transcript", carried_value(transcript)));
        let mut out = vec![meta, carrier.value()];
        out.extend(values);
        out
    }

    fn detach(&self, units: &[Unit]) -> Option<(Value, Vec<Unit>)> {
        let index =
            units.iter().position(|u| u.value.is("type", "atxf") && u.value.obj("payload").and_then(|p| p.obj("transcript")).is_some())?;
        let transcript = units[index].value.obj("payload")?.get("transcript")?.clone();
        let rest = units.iter().enumerate().filter(|(i, _)| *i != index).map(|(_, u)| u.clone()).collect();
        Some((transcript, rest))
    }
}

fn session_header(line: &Map, native: Option<Map>) -> Map {
    let meta = obj_or_empty(line.field("payload"));
    let git = obj_or_empty(meta.field("git"));
    let parent = meta.str("forked_from_id").or_else(|| meta.str("parent_thread_id")).filter(|p| !p.is_empty());
    let workspace = (meta.str("cwd").is_some() || git.str("branch").is_some()).then(|| {
        let vcs = (git.str("branch").is_some() || git.str("commit_hash").is_some()).then(|| {
            Obj::new()
                .set("type", "git")
                .opt("branch", git.str("branch"))
                .opt("commit", git.str("commit_hash"))
                .opt("remote", git.str("repository_url"))
        });
        Obj::new().opt("cwd", meta.str("cwd")).opt("vcs", vcs)
    });
    Obj::new()
        .set("type", "transcript")
        .set("atxf", "0.1")
        .set("id", meta.nonempty("id").unwrap_or("codex-session"))
        .set("time", iso_time(meta.field("timestamp"), &iso_time(line.field("timestamp"), EPOCH)))
        .set(
            "source",
            Obj::new().set("agent", AGENT).set("format", FORMAT).opt("version", meta.str("cli_version")).opt("sessionId", meta.str("id")),
        )
        .opt("workspace", workspace)
        .opt(
            "parent",
            parent.map(|p| {
                Obj::new().set("transcriptId", p).set("relation", if meta.str("forked_from_id").is_some() { "fork" } else { "subagent" })
            }),
        )
        .set(
            "fidelity",
            Obj::new()
                .set("topology", "linear")
                .set("instructions", "partial")
                .set("turns", true)
                .set("usage", "aggregate")
                .set("native", "all")
                .set("ids", "synthetic"),
        )
        .opt("native", native)
        .build()
}

/// A Responses item as a message body, or `None` when it has none (or, without a tree, a tool call).
fn response_item(item: &Map, tree: Option<&TreeBuilder<'_>>) -> Option<Map> {
    match item.str("type")? {
        "message" => {
            let parts = item.arr("content")?;
            if item.is("role", "assistant") {
                let content: Vec<Value> =
                    parts.iter().filter_map(|p| p.str("text")).map(|t| Obj::new().set("type", "text").set("text", t).value()).collect();
                return Some(Obj::new().set("role", "assistant").set("content", Value::Array(content)).build());
            }
            let content = user_content(parts);
            let role = if item.is("role", "developer") || item.is("role", "system") { "system" } else { "user" };
            Some(Obj::new().set("role", role).set("content", content).build())
        }
        "reasoning" => {
            let summary: Vec<Value> = item.arr("summary").into_iter().flatten().filter_map(|s| s.str("text")).map(Value::from).collect();
            let text = item.arr("content").map(|c| c.iter().filter_map(|c| c.str("text")).collect::<Vec<_>>().join("\n"));
            let replay = item.str("encrypted_content").map(|e| {
                Value::Array(vec![
                    Obj::new().set("provider", "openai").set("api", "responses").set("kind", "encrypted_content").set("data", e).value(),
                ])
            });
            // A reasoning block needs text, a summary or replay data; an empty item keeps an empty summary.
            let keep_summary = !summary.is_empty() || (text.is_none() && replay.is_none());
            let block = Obj::new()
                .set("type", "reasoning")
                .opt("text", text)
                .opt("summary", keep_summary.then_some(Value::Array(summary)))
                .opt("replay", replay);
            Some(Obj::new().set("role", "assistant").set("content", Value::Array(vec![block.value()])).build())
        }
        "function_call" | "custom_tool_call" | "local_shell_call" | "web_search_call" => {
            let tree = tree?;
            let id = item.str("call_id").or_else(|| item.str("id"))?;
            if tree.has_tool_call(id) {
                return None;
            }
            Some(Obj::new().set("role", "assistant").set("content", Value::Array(vec![tool_call(item, id)])).build())
        }
        "function_call_output" | "custom_tool_call_output" => {
            let call = item.str("call_id")?;
            tree?;
            let output = item.field("output");
            let is_error = output.and_then(Value::as_object).is_some_and(|o| o.field("success") == Some(&Value::Bool(false)));
            let content = match output {
                Some(Value::String(s)) => Value::String(s.clone()),
                Some(Value::Object(o)) if o.str("content").is_some() => o["content"].clone(),
                Some(Value::Array(parts)) => user_content(parts),
                _ => s(""),
            };
            Some(
                Obj::new()
                    .set("role", "tool")
                    .set("toolCallId", call)
                    .set("content", content)
                    .opt("isError", is_error.then_some(true))
                    .build(),
            )
        }
        _ => None,
    }
}

/// `JSON.parse(String(value))`, as the TypeScript implementation parses `arguments`.
fn parse_arguments(value: Option<&Value>) -> Option<Value> {
    let text = match value? {
        Value::String(s) => s.clone(),
        other => to_js_string(other),
    };
    json::parse(&text).ok()
}

fn tool_call(item: &Map, id: &str) -> Value {
    // `String(item.name ?? "")`.
    let name = || to_js_string(&or_else(item.field("name"), || s("")));
    match item.str("type") {
        Some("function_call") => match parse_arguments(item.field("arguments")) {
            Some(Value::Object(args)) => Obj::new()
                .set("type", "tool_call")
                .set("id", id)
                .set("name", name())
                .set("kind", "function")
                .opt("namespace", item.str("namespace"))
                .set("arguments", Value::Object(args))
                .value(),
            _ => Obj::new()
                .set("type", "tool_call")
                .set("id", id)
                .set("name", name())
                .set("kind", "function")
                .set("input", item.str("arguments").unwrap_or(""))
                .value(),
        },
        Some("custom_tool_call") => Obj::new()
            .set("type", "tool_call")
            .set("id", id)
            .set("name", name())
            .set("kind", "custom")
            .set("input", item.str("input").unwrap_or(""))
            .value(),
        Some("local_shell_call") => Obj::new()
            .set("type", "tool_call")
            .set("id", id)
            .set("name", "local_shell")
            .set("kind", "builtin")
            .set("arguments", item.obj("action").cloned().unwrap_or_default())
            .value(),
        _ => Obj::new()
            .set("type", "tool_call")
            .set("id", id)
            .set("name", "web_search")
            .set("kind", "builtin")
            .set("arguments", item.obj("action").cloned().unwrap_or_default())
            .value(),
    }
}

fn user_content(parts: &[Value]) -> Value {
    let mut blocks = Vec::new();
    for part in parts {
        let Some(part) = part.as_object() else { continue };
        if let Some(text) = part.str("text") {
            blocks.push(Obj::new().set("type", "text").set("text", text).value());
        } else if let (true, Some(url)) = (part.is("type", "input_image"), part.str("image_url")) {
            blocks.push(match data_url(url) {
                Some((media, data)) => Obj::new().set("type", "image").set("mediaType", media).set("data", data).value(),
                None => Obj::new().set("type", "image").set("mediaType", "image/*").set("uri", url).value(),
            });
        }
    }
    Value::Array(blocks)
}

/// `/^data:([^;]+);base64,(.*)$/s`.
fn data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let semi = rest.find(';')?;
    if semi == 0 {
        return None;
    }
    Some((&rest[..semi], rest[semi..].strip_prefix(";base64,")?))
}

fn token_usage(value: Option<&Value>) -> Option<Value> {
    let value = value?.as_object()?;
    let input = count(value.field("input_tokens"))?;
    let output = count(value.field("output_tokens"))?;
    Some(
        Obj::new()
            .set("input", number(input))
            .set("output", number(output))
            .opt("cacheRead", count(value.field("cached_input_tokens")).map(number))
            .opt("cacheWrite", count(value.field("cache_write_input_tokens")).map(number))
            .opt("reasoning", count(value.field("reasoning_output_tokens")).map(number))
            .opt("total", count(value.field("total_tokens")).map(number))
            .value(),
    )
}

fn encode(transcript: &Transcript) -> Vec<Encoded> {
    let context = build_context(transcript, &BuildContextOptions::default());
    let header = &transcript.header;
    let times: HashMap<&str, &str> = transcript.records.iter().map(|r| (r.id(), r.time())).collect();
    let mut out = Vec::new();
    let mut time = header.field("time").cloned().unwrap_or(Value::Null);
    let mut line = |kind: &str, payload: Value, source: Option<&str>| {
        if let Some(t) = source.and_then(|s| times.get(s)) {
            time = s(*t);
        }
        out.push(Encoded {
            value: Obj::new().set("timestamp", time.clone()).set("type", kind).set("payload", payload).value(),
            source: source.map(str::to_string),
        });
    };

    let instructions = context.instructions.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>().join("\n\n");
    let workspace_cwd = header.obj("workspace").and_then(|w| w.field("cwd"));
    let meta = Obj::new()
        .set("id", or_else(header.obj("source").and_then(|s| s.field("sessionId")), || header.field("id").cloned().unwrap_or(Value::Null)))
        .opt("timestamp", header.field("time").cloned())
        .set("cwd", or_else(workspace_cwd, || or_else(context.settings.field("cwd"), || s("/"))))
        .set("originator", "atxf")
        .set("cli_version", "0.0.0")
        .set("source", "cli")
        .opt("model_provider", context.model().and_then(|m| m.field("provider")).cloned())
        .opt("base_instructions", (!instructions.is_empty()).then(|| Obj::new().set("text", instructions.as_str())));
    line("session_meta", meta.value(), None);
    let effort = context.settings.field("reasoningEffort").filter(|v| json::truthy(v));
    let settings_cwd = context.settings.field("cwd").filter(|v| json::truthy(v));
    if context.model().is_some() || effort.is_some() || settings_cwd.is_some() {
        let payload = Obj::new()
            .set("cwd", or_else(context.settings.field("cwd"), || or_else(workspace_cwd, || s("/"))))
            .opt("model", context.model().and_then(|m| m.field("id")).cloned())
            .opt("effort", context.settings.field("reasoningEffort").cloned());
        line("turn_context", payload.value(), None);
    }

    for (index, message) in context.messages.iter().enumerate() {
        let body = &message.body;
        let source = Some(message.source_id.as_str());
        if message.kind.is_summary() {
            // A compaction starts the context; a summary later on can only be a user message.
            if index == 0 {
                line("compacted", Obj::new().set("message", text_of(body.field("content"))).value(), source);
            } else {
                line(
                    "response_item",
                    Obj::new().set("type", "message").set("role", "user").set("content", codex_content(body.field("content"))).value(),
                    source,
                );
            }
            continue;
        }
        match body.str("role").unwrap_or("") {
            role @ ("system" | "user") => {
                let hidden = role == "system"
                    || body.field("display") == Some(&Value::Bool(false))
                    || body.obj("origin").is_some_and(|o| o.field("kind") != Some(&s("human")));
                let payload = Obj::new()
                    .set("type", "message")
                    .set("role", if hidden { "developer" } else { "user" })
                    .set("content", codex_content(body.field("content")));
                line("response_item", payload.value(), source);
            }
            "tool" => {
                let text = text_of(body.field("content"));
                let output = if body.field("isError").is_some_and(json::truthy) {
                    Obj::new().set("content", text).set("success", false).value()
                } else {
                    s(text)
                };
                let payload =
                    Obj::new().set("type", "function_call_output").opt("call_id", body.field("toolCallId").cloned()).set("output", output);
                line("response_item", payload.value(), source);
            }
            "assistant" => {
                let blocks = body.arr("content").map_or(&[][..], Vec::as_slice);
                if blocks.is_empty() {
                    line(
                        "response_item",
                        Obj::new().set("type", "message").set("role", "assistant").set("content", Value::Array(vec![])).value(),
                        source,
                    );
                }
                for block in blocks {
                    match block.str("type") {
                        Some("reasoning") => {
                            let encrypted = replay_data(block.field("replay"), "encrypted_content", Some("openai"), false)
                                .filter(|v| v.is_string())
                                .cloned()
                                .unwrap_or(Value::Null);
                            let summary: Vec<Value> = block
                                .arr("summary")
                                .into_iter()
                                .flatten()
                                .map(|t| Obj::new().set("type", "summary_text").set("text", t.clone()).value())
                                .collect();
                            let payload = Obj::new()
                                .set("type", "reasoning")
                                .set("summary", Value::Array(summary))
                                .opt(
                                    "content",
                                    block.field("text").map(|t| {
                                        Value::Array(vec![Obj::new().set("type", "reasoning_text").set("text", t.clone()).value()])
                                    }),
                                )
                                .set("encrypted_content", encrypted);
                            line("response_item", payload.value(), source);
                        }
                        Some("text") => {
                            let content =
                                Value::Array(vec![Obj::new().set("type", "output_text").opt("text", block.field("text").cloned()).value()]);
                            line(
                                "response_item",
                                Obj::new().set("type", "message").set("role", "assistant").set("content", content).value(),
                                source,
                            );
                        }
                        Some("tool_call") => {
                            let custom = block.is("kind", "custom");
                            if custom || (block.field("arguments").is_none() && block.field("input").is_some()) {
                                let input = or_else(block.field("input"), || s(""));
                                let payload = Obj::new()
                                    .set("type", if custom { "custom_tool_call" } else { "function_call" })
                                    .opt("call_id", block.field("id").cloned())
                                    .opt("name", block.field("name").cloned())
                                    .set(if custom { "input" } else { "arguments" }, input);
                                line("response_item", payload.value(), source);
                            } else {
                                let args = or_else(block.field("arguments"), || Value::Object(Map::new()));
                                let payload = Obj::new()
                                    .set("type", "function_call")
                                    .opt("name", block.field("name").cloned())
                                    .opt("namespace", block.field("namespace").cloned())
                                    .set("arguments", json::stringify(&args))
                                    .opt("call_id", block.field("id").cloned());
                                line("response_item", payload.value(), source);
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn codex_content(content: Option<&Value>) -> Value {
    match content {
        Some(Value::String(text)) => Value::Array(vec![Obj::new().set("type", "input_text").set("text", text.as_str()).value()]),
        Some(Value::Array(blocks)) => Value::Array(
            blocks
                .iter()
                .map(|block| match block.str("type") {
                    Some("text") => Obj::new().set("type", "input_text").opt("text", block.field("text").cloned()).value(),
                    Some("image") => {
                        let url = match block.field("data") {
                            Some(data) => s(format!(
                                "data:{};base64,{}",
                                block.field("mediaType").map_or_else(|| "undefined".to_string(), to_js_string),
                                to_js_string(data)
                            )),
                            None => or_else(block.field("uri"), || s("")),
                        };
                        Obj::new().set("type", "input_image").set("image_url", url).value()
                    }
                    _ => {
                        let text = or_else(block.field("text"), || {
                            s(format!("[{}]", block.field("uri").map_or_else(|| "undefined".to_string(), to_js_string)))
                        });
                        Obj::new().set("type", "input_text").set("text", text).value()
                    }
                })
                .collect(),
        ),
        _ => Value::Null,
    }
}

/// The text of content: images as `[image]`, resources as their text or `[uri]`.
fn text_of(content: Option<&Value>) -> String {
    content_text(content)
}
