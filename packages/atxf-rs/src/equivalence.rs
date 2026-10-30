//! Conversations reduced to what every agent format can carry, to compare conversions.

use crate::canonical::canonical_json;
use crate::context::{BuildContextOptions, build_context};
use crate::json::{Get, Map, Obj, Value, to_js_string};
use crate::transcript::Transcript;

/// A portable message: `role` (user, assistant, tool or summary), `text`, and optionally `toolCalls`
/// (`{id, name, arguments}` with canonical JSON arguments), `toolCallId`, `isError` and `reasoning`. Kept as JSON
/// so views compare and print exactly as the TypeScript implementation's do.
pub type PortableMessage = Map;

/// The text of user content: text as is, an image as `[image]`, a resource as its text or `[uri]`.
pub fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|block| {
                let text = |v: Option<&Value>| match v {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(to_js_string(v)),
                };
                match block.str("type") {
                    Some("text") => text(block.field("text")).unwrap_or_default(),
                    Some("image") => "[image]".to_string(),
                    _ => text(block.field("text"))
                        .unwrap_or_else(|| format!("[{}]", block.field("uri").map_or_else(|| "undefined".to_string(), to_js_string))),
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn join_nonempty(parts: &[&str]) -> String {
    parts.iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join("\n")
}

/// The conversation a model would see at the active leaf, reduced to portable fields. Consecutive assistant
/// messages merge into one and empty text parts are ignored, since formats split one response differently.
pub fn conversation_view(transcript: &Transcript, reasoning: bool) -> Vec<PortableMessage> {
    let mut view: Vec<PortableMessage> = Vec::new();
    for message in build_context(transcript, &BuildContextOptions::default()).messages {
        let body = &message.body;
        if message.kind.is_summary() {
            view.push(Obj::new().set("role", "summary").set("text", content_text(body.field("content"))).build());
            continue;
        }
        let role = body.str("role").unwrap_or("");
        if role == "system" || body.field("display") == Some(&Value::Bool(false)) {
            continue;
        }
        if let Some(origin) = body.obj("origin").and_then(|o| o.field("kind"))
            && !matches!(origin.as_str(), Some("human" | "model" | "tool"))
        {
            continue;
        }
        match role {
            "user" => view.push(Obj::new().set("role", "user").set("text", content_text(body.field("content"))).build()),
            "tool" => view.push(
                Obj::new()
                    .set("role", "tool")
                    .set("text", content_text(body.field("content")))
                    .opt("toolCallId", body.field("toolCallId").cloned())
                    .set("isError", body.field("isError") == Some(&Value::Bool(true)))
                    .build(),
            ),
            "assistant" => {
                let blocks = body.arr("content").map_or(&[][..], Vec::as_slice);
                let text = blocks
                    .iter()
                    .filter(|b| b.is("type", "text") && b.str("text") != Some(""))
                    .map(|b| b.field("text").map(to_js_string).unwrap_or_default())
                    .collect::<Vec<_>>()
                    .join("\n");
                let calls: Vec<Value> = blocks
                    .iter()
                    .filter(|b| b.is("type", "tool_call"))
                    .map(|b| {
                        let arguments = match b.defined("arguments") {
                            Some(args) => canonical_json(args),
                            None => canonical_json(&Obj::new().opt("input", b.field("input").cloned()).value()),
                        };
                        Obj::new()
                            .opt("id", b.field("id").cloned())
                            .opt("name", b.field("name").cloned())
                            .set("arguments", arguments)
                            .value()
                    })
                    .collect();
                let thinking = blocks
                    .iter()
                    .filter(|b| b.is("type", "reasoning"))
                    .filter_map(|b| b.str("text").filter(|t| !t.is_empty()))
                    .collect::<Vec<_>>()
                    .join("\n");
                if let Some(previous) = view.last_mut().filter(|p| p.is("role", "assistant")) {
                    let merged = join_nonempty(&[previous.str("text").unwrap_or(""), &text]);
                    previous.insert("text".into(), Value::String(merged));
                    if !calls.is_empty() {
                        let mut all = previous.arr("toolCalls").cloned().unwrap_or_default();
                        all.extend(calls);
                        previous.insert("toolCalls".into(), Value::Array(all));
                    }
                    if reasoning && !thinking.is_empty() {
                        let merged = join_nonempty(&[previous.str("reasoning").unwrap_or(""), &thinking]);
                        previous.insert("reasoning".into(), Value::String(merged));
                    }
                    continue;
                }
                view.push(
                    Obj::new()
                        .set("role", "assistant")
                        .set("text", text)
                        .opt("toolCalls", (!calls.is_empty()).then_some(Value::Array(calls)))
                        .opt("reasoning", (reasoning && !thinking.is_empty()).then_some(thinking))
                        .build(),
                );
            }
            _ => {}
        }
    }
    view
}

/// For formats that store a tool result inside the call it answers (OpenCode, Gemini CLI): each result moves right
/// after the assistant message holding its call, and results whose call is not in the view are dropped.
pub fn embedded_tool_results(view: Vec<PortableMessage>) -> Vec<PortableMessage> {
    let mut results: Vec<(String, PortableMessage)> = Vec::new();
    for message in &view {
        if let (true, Some(id)) = (message.is("role", "tool"), message.str("toolCallId").filter(|id| !id.is_empty()))
            && !results.iter().any(|(k, _)| k == id)
        {
            results.push((id.to_string(), message.clone()));
        }
    }
    let mut merged: Vec<PortableMessage> = Vec::new();
    for message in view {
        if message.is("role", "tool") {
            continue;
        }
        match merged.last_mut() {
            Some(previous) if message.is("role", "assistant") && previous.is("role", "assistant") => {
                let text = join_nonempty(&[previous.str("text").unwrap_or(""), message.str("text").unwrap_or("")]);
                let calls = (previous.has("toolCalls") || message.has("toolCalls")).then(|| {
                    let mut all = previous.arr("toolCalls").cloned().unwrap_or_default();
                    all.extend(message.arr("toolCalls").cloned().unwrap_or_default());
                    Value::Array(all)
                });
                *previous = Obj::new().spread(previous).set("text", text).opt("toolCalls", calls).build();
            }
            _ => merged.push(message),
        }
    }
    let mut out = Vec::new();
    for message in merged {
        let calls = message.arr("toolCalls").cloned().unwrap_or_default();
        out.push(message);
        for call in calls {
            if let Some((_, result)) = results.iter().find(|(id, _)| Some(id.as_str()) == call.str("id")) {
                out.push(result.clone());
            }
        }
    }
    out
}

/// For formats whose only summary is a compaction that must start the context (Codex, OpenCode), or that have none
/// (Gemini CLI): summaries compare as user messages.
pub fn summaries_as_user(view: Vec<PortableMessage>) -> Vec<PortableMessage> {
    view.into_iter()
        .map(|message| if message.is("role", "summary") { Obj::new().spread(&message).set("role", "user").build() } else { message })
        .collect()
}

/// The view each format keeps without the carried transcript (SPEC §11.1, faithful view).
pub fn format_view(agent: &str, view: Vec<PortableMessage>) -> Vec<PortableMessage> {
    match agent {
        "codex" => summaries_as_user(view),
        "opencode" | "gemini-cli" => embedded_tool_results(summaries_as_user(view)),
        _ => view,
    }
}

/// Whether two views are the same conversation.
pub fn same_view(a: &[PortableMessage], b: &[PortableMessage]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| canonical_json(&Value::Object(x.clone())) == canonical_json(&Value::Object(y.clone())))
}
