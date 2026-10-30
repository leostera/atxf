//! Model context at a position in the tree (SPEC §5, §6).

use std::collections::HashMap;

use crate::json::{Get, Map, Obj, Value, entries, s, truthy};
use crate::transcript::{Record, Transcript};
use crate::tree::{TreeIndex, index_tree, path_to};

/// How a context message came about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageKind {
    Message,
    CompactionSummary,
    CompactionReplacement,
    BranchSummary,
}

impl MessageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::CompactionSummary => "compaction_summary",
            Self::CompactionReplacement => "compaction_replacement",
            Self::BranchSummary => "branch_summary",
        }
    }

    /// A summary of earlier context: a compaction's or a branch's.
    pub fn is_summary(self) -> bool {
        matches!(self, Self::CompactionSummary | Self::BranchSummary)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ContextMessage {
    /// A message body: `role`, `content` and the role's other fields.
    pub body: Map,
    /// The tree record the message comes from.
    pub source_id: String,
    pub kind: MessageKind,
}

/// The model-visible state at one position in the tree.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelContext {
    pub leaf: Option<String>,
    /// Instruction sections, `(name, text)`, in the order they were first set.
    pub instructions: Vec<(String, String)>,
    pub tools: Vec<Map>,
    pub messages: Vec<ContextMessage>,
    /// The folded `settings` fields (SPEC §6).
    pub settings: Map,
}

impl ModelContext {
    /// The JSON form the TypeScript implementation's `buildContext` returns.
    pub fn to_value(&self) -> Value {
        Obj::new()
            .set("leaf", self.leaf.clone().map_or(Value::Null, Value::String))
            .set(
                "instructions",
                Value::Array(
                    self.instructions.iter().map(|(n, t)| Obj::new().set("name", n.as_str()).set("text", t.as_str()).value()).collect(),
                ),
            )
            .set("tools", Value::Array(self.tools.iter().cloned().map(Value::Object).collect()))
            .set(
                "messages",
                Value::Array(
                    self.messages
                        .iter()
                        .map(|m| {
                            Obj::new()
                                .set("body", Value::Object(m.body.clone()))
                                .set("sourceId", m.source_id.as_str())
                                .set("kind", m.kind.as_str())
                                .value()
                        })
                        .collect(),
                ),
            )
            .set("settings", Value::Object(self.settings.clone()))
            .value()
    }

    /// The model the context is set to, `settings.model`.
    pub fn model(&self) -> Option<&Map> {
        self.settings.obj("model")
    }
}

/// Where to build context, and for which target.
#[derive(Clone, Debug, Default)]
pub struct BuildContextOptions<'a> {
    /// Position in the tree; `None` means the active leaf, `Some(None)` the empty path.
    pub leaf: Option<Option<&'a str>>,
    /// Keep only replay data for this provider and API (SPEC §10).
    pub target: Option<(&'a str, Option<&'a str>)>,
}

/// The records that contribute to model context at the end of `path` (SPEC §5 step 1): the last compaction and
/// what it keeps, or the whole path. Returns the range, the compaction, and the records before it.
pub fn working_range<'a>(path: &[&'a Map]) -> (Vec<&'a Map>, Option<&'a Map>, Vec<&'a Map>) {
    let Some(at) = path.iter().rposition(|r| r.kind() == "compaction") else {
        return (path.to_vec(), None, Vec::new());
    };
    let compaction = path[at];
    let mut kept: &[&Map] = &[];
    if compaction.is("strategy", "summary")
        && let Some(first) = compaction.str("firstKeptId").filter(|s| !s.is_empty())
        && let Some(from) = path.iter().position(|r| r.id() == first)
        && from < at
    {
        kept = &path[from..at];
    }
    let mut range = vec![compaction];
    range.extend_from_slice(kept);
    range.extend_from_slice(&path[at + 1..]);
    (range, Some(compaction), path[..at].to_vec())
}

pub fn build_context(transcript: &Transcript, options: &BuildContextOptions<'_>) -> ModelContext {
    let index = index_tree(transcript);
    build_context_with(&index, options)
}

pub fn build_context_with(index: &TreeIndex<'_>, options: &BuildContextOptions<'_>) -> ModelContext {
    let leaf = options.leaf.unwrap_or(index.active_leaf);
    let path = path_to(index, leaf);
    let (range, compaction, before) = working_range(&path);

    let mut prompt = PromptState::default();
    match compaction.and_then(|c| c.obj("snapshot")) {
        Some(snapshot) => prompt
            .replace(snapshot.arr("instructions").map_or(&[][..], Vec::as_slice), snapshot.arr("tools").map_or(&[][..], Vec::as_slice)),
        None => {
            for record in &before {
                if record.kind() == "context" {
                    prompt.apply(record);
                }
            }
        }
    }
    for record in &range {
        if record.kind() == "context" {
            prompt.apply(record);
        }
    }

    let edits = latest_edits(&path);
    let mut messages = Vec::new();
    for record in &range {
        match record.kind() {
            "message" => {
                let edit = edits.get(record.id());
                if matches!(edit, Some(Value::Null)) {
                    continue;
                }
                let body = message_body(record);
                let body = match edit {
                    Some(replacement) => with_content(body, replacement),
                    None => body,
                };
                messages.push(ContextMessage { body, source_id: record.id().to_string(), kind: MessageKind::Message });
            }
            "compaction" => {
                if record.is("strategy", "replace") {
                    for body in record.arr("replacement").into_iter().flatten() {
                        if let Value::Object(body) = body {
                            messages.push(ContextMessage {
                                body: body.clone(),
                                source_id: record.id().to_string(),
                                kind: MessageKind::CompactionReplacement,
                            });
                        }
                    }
                } else {
                    let summary = record.field("summary").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| s(""));
                    messages.push(ContextMessage {
                        body: Obj::new()
                            .set("role", "user")
                            .set("content", summary)
                            .set("origin", Obj::new().set("kind", "synthetic").set("name", "compaction"))
                            .build(),
                        source_id: record.id().to_string(),
                        kind: MessageKind::CompactionSummary,
                    });
                }
            }
            "branch_summary" => messages.push(ContextMessage {
                body: Obj::new()
                    .set("role", "user")
                    .set("content", record.field("summary").cloned().unwrap_or(Value::Null))
                    .set("origin", Obj::new().set("kind", "synthetic").set("name", "branch_summary"))
                    .build(),
                source_id: record.id().to_string(),
                kind: MessageKind::BranchSummary,
            }),
            _ => {}
        }
    }

    let (instructions, tools) = prompt.snapshot();
    ModelContext {
        leaf: leaf.map(str::to_string),
        instructions,
        tools,
        messages: match options.target {
            Some(target) => filter_replay(messages, target),
            None => messages,
        },
        settings: fold_settings(&path),
    }
}

/// The working range at the active leaf with context edits applied (SPEC §5 steps 1 and 4), as records: edited
/// messages carry their replacement content; omitted ones and the edits themselves are dropped.
pub fn project_range(transcript: &Transcript) -> Vec<Map> {
    let index = index_tree(transcript);
    let path = path_to(&index, index.active_leaf);
    let edits = latest_edits(&path);
    let (range, _, _) = working_range(&path);
    let mut out = Vec::new();
    for record in range {
        match record.kind() {
            "context_edit" => {}
            "message" => match edits.get(record.id()) {
                None => out.push(record.clone()),
                Some(Value::Null) => {}
                Some(edit) => {
                    let mut obj = Obj::new();
                    for key in ["type", "id", "parentId", "time"] {
                        obj = obj.opt(key, record.field(key).cloned());
                    }
                    obj = obj
                        .opt("native", record.field("native").filter(|v| truthy(v)).cloned())
                        .opt("ext", record.field("ext").filter(|v| truthy(v)).cloned());
                    out.push(obj.spread(&with_content(message_body(record), edit)).build());
                }
            },
            _ => out.push(record.clone()),
        }
    }
    out
}

const SETTINGS_KEYS: [&str; 6] = ["model", "reasoningEffort", "agent", "mode", "cwd", "policy"];

/// Folds `settings` records field by field (SPEC §6).
pub fn fold_settings(path: &[&Map]) -> Map {
    let mut settings = Map::new();
    for record in path {
        if record.kind() != "settings" {
            continue;
        }
        for key in SETTINGS_KEYS {
            if let Some(value) = record.field(key) {
                settings.insert(key.to_string(), value.clone());
            }
        }
    }
    settings
}

/// Instructions and tool loadout, folded from `context` records (SPEC §5 step 2). Both keep the order in which
/// names were first set, as a JavaScript `Map` does.
#[derive(Clone, Debug, Default)]
pub struct PromptState {
    sections: Vec<(String, String)>,
    tools: Vec<(String, Map)>,
}

fn upsert<T>(list: &mut Vec<(String, T)>, key: &str, value: T) {
    match list.iter_mut().find(|(k, _)| k == key) {
        Some(entry) => entry.1 = value,
        None => list.push((key.to_string(), value)),
    }
}

impl PromptState {
    pub fn replace(&mut self, instructions: &[Value], tools: &[Value]) {
        self.sections.clear();
        self.tools.clear();
        for section in instructions {
            if let (Some(name), Some(text)) = (section.str("name"), section.str("text")) {
                upsert(&mut self.sections, name, text.to_string());
            }
        }
        for tool in tools {
            if let (Some(name), Some(map)) = (tool.str("name"), tool.as_object()) {
                upsert(&mut self.tools, name, map.clone());
            }
        }
    }

    pub fn apply(&mut self, record: &Map) {
        let instructions = record.arr("instructions").map_or(&[][..], Vec::as_slice);
        if record.is("mode", "replace") {
            return self.replace(instructions, record.arr("toolsAdded").map_or(&[][..], Vec::as_slice));
        }
        for section in instructions {
            let Some(name) = section.str("name") else { continue };
            match section.str("text") {
                Some(text) => upsert(&mut self.sections, name, text.to_string()),
                None => self.sections.retain(|(k, _)| k != name),
            }
        }
        for name in record.arr("toolsRemoved").into_iter().flatten().filter_map(Value::as_str) {
            self.tools.retain(|(k, _)| k != name);
        }
        for tool in record.arr("toolsAdded").into_iter().flatten() {
            if let (Some(name), Some(map)) = (tool.str("name"), tool.as_object()) {
                upsert(&mut self.tools, name, map.clone());
            }
        }
    }

    pub fn snapshot(&self) -> (Vec<(String, String)>, Vec<Map>) {
        (self.sections.clone(), self.tools.iter().map(|(_, t)| t.clone()).collect())
    }
}

fn latest_edits<'a>(path: &[&'a Map]) -> HashMap<&'a str, &'a Value> {
    let mut edits = HashMap::new();
    for record in path {
        if record.kind() == "context_edit"
            && let (Some(target), Some(replacement)) = (record.str("targetId"), record.field("replacement"))
        {
            edits.insert(target, replacement);
        }
    }
    edits
}

const ENVELOPE_KEYS: [&str; 6] = ["type", "id", "parentId", "time", "native", "ext"];

/// A `message` record without its envelope.
pub fn message_body(record: &Map) -> Map {
    let mut body = Map::new();
    for (key, value) in entries(record) {
        if !ENVELOPE_KEYS.contains(&key.as_str()) {
            body.insert(key.clone(), value.clone());
        }
    }
    body
}

fn with_content(body: Map, replacement: &Value) -> Map {
    let role = body.str("role").unwrap_or("");
    let content = if (role == "assistant" || role == "tool") && replacement.is_string() {
        Value::Array(vec![Obj::new().set("type", "text").set("text", replacement.clone()).value()])
    } else {
        replacement.clone()
    };
    Obj::new().spread(&body).set("content", content).build()
}

fn matches_target(replay: &Value, (provider, api): (&str, Option<&str>)) -> bool {
    replay.str("provider") == Some(provider) && (replay.field("api").is_none() || api.is_none() || replay.str("api") == api)
}

fn filter_replay(messages: Vec<ContextMessage>, target: (&str, Option<&str>)) -> Vec<ContextMessage> {
    let keep = |replay: Option<&Value>| -> Option<Value> {
        let kept: Vec<Value> = replay?.as_array()?.iter().filter(|e| matches_target(e, target)).cloned().collect();
        (!kept.is_empty()).then_some(Value::Array(kept))
    };
    messages
        .into_iter()
        .map(|message| {
            if !message.body.is("role", "assistant") {
                return message;
            }
            let mut content = Vec::new();
            for block in message.body.arr("content").into_iter().flatten() {
                let Some(map) = block.as_object() else {
                    content.push(block.clone());
                    continue;
                };
                if map.field("replay").is_none() {
                    content.push(block.clone());
                    continue;
                }
                let mut rest = map.clone();
                rest.shift_remove("replay");
                let replay = keep(map.field("replay"));
                let filtered = match &replay {
                    Some(replay) => Obj::new().spread(&rest).set("replay", replay.clone()).build(),
                    None => rest,
                };
                if filtered.is("type", "reasoning")
                    && filtered.field("text").is_none()
                    && filtered.field("summary").is_none()
                    && replay.is_none()
                {
                    continue;
                }
                content.push(Value::Object(filtered));
            }
            let mut rest = message.body.clone();
            rest.shift_remove("replay");
            let replay = keep(message.body.field("replay"));
            let body = Obj::new().spread(&rest).opt("replay", replay).set("content", Value::Array(content)).build();
            ContextMessage { body, ..message }
        })
        .collect()
}
