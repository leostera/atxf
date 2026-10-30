//! Lossless converters for coding-agent session formats.

mod claude_code;
mod codex;
mod gemini_cli;
mod opencode;
mod pi;

pub use claude_code::{ClaudeCode, uuid_for};
pub use codex::Codex;
pub use gemini_cli::GeminiCli;
pub use opencode::OpenCode;
pub use pi::Pi;

use crate::codec::Converter;
use crate::json::{Get, Map, Obj, Value};

pub static PI: Pi = Pi;
pub static CLAUDE_CODE: ClaudeCode = ClaudeCode;
pub static CODEX: Codex = Codex;
pub static OPENCODE: OpenCode = OpenCode;
pub static GEMINI_CLI: GeminiCli = GeminiCli;

/// Every converter.
pub fn all() -> [&'static dyn Converter; 5] {
    [&PI, &CLAUDE_CODE, &CODEX, &OPENCODE, &GEMINI_CLI]
}

/// The converter for an agent, by name: `pi`, `claude-code`, `codex`, `opencode` or `gemini-cli`.
pub fn by_agent(agent: &str) -> Option<&'static dyn Converter> {
    all().into_iter().find(|c| c.agent() == agent)
}

/// The envelope of a tree record being decoded: `{id, parentId, time}`.
#[derive(Clone, Debug)]
pub(crate) struct Node {
    pub id: String,
    pub parent_id: Option<String>,
    pub time: String,
}

impl Node {
    /// `{type, ...node}`: a record of `kind` with this envelope, to add fields to.
    pub fn record(&self, kind: &str) -> Obj {
        Obj::new()
            .set("type", kind)
            .set("id", self.id.as_str())
            .set("parentId", opt_str(self.parent_id.as_deref()))
            .set("time", self.time.as_str())
    }
}

/// A string or `null`.
pub(crate) fn opt_str(s: Option<&str>) -> Value {
    s.map_or(Value::Null, Value::from)
}

/// The object at `value`, or an empty one (`isObject(v) ? v : {}`).
pub(crate) fn obj_or_empty(value: Option<&Value>) -> Map {
    value.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// Text of the text blocks in `content`, joined by newlines; `content` itself when it is a string.
pub(crate) fn text_blocks(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => {
            blocks.iter().filter(|b| b.is("type", "text")).filter_map(|b| b.str("text")).collect::<Vec<_>>().join("\n")
        }
        _ => String::new(),
    }
}

/// `replay?.find((r) => r.kind === kind && …)?.data`, for replay data of one provider or any.
pub(crate) fn replay_data<'a>(replay: Option<&'a Value>, kind: &str, provider: Option<&str>, string_only: bool) -> Option<&'a Value> {
    replay?
        .as_array()?
        .iter()
        .find(|r| {
            provider.is_none_or(|p| r.is("provider", p))
                && r.is("kind", kind)
                && (!string_only || r.field("data").is_some_and(Value::is_string))
        })?
        .field("data")
}

/// `obj.key ?? fallback` for strings, cloning the value (which may be any JSON).
pub(crate) fn or_else(value: Option<&Value>, fallback: impl FnOnce() -> Value) -> Value {
    value.filter(|v| !v.is_null()).cloned().unwrap_or_else(fallback)
}
