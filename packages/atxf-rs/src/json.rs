//! JSON as JavaScript sees it.
//!
//! ATXF output must be byte-identical to the TypeScript implementation's, so this module reproduces what
//! `JSON.parse` and `JSON.stringify` do: numbers are IEEE doubles printed the ECMAScript way, objects list
//! integer-like keys first in ascending order and every other key in insertion order, and strings escape exactly
//! what `JSON.stringify` escapes. Objects keep insertion order in storage ([`Map`] with `preserve_order`); the
//! JavaScript order is applied whenever an object is iterated ([`keys`], [`entries`]) or written.

use std::cmp::Ordering;
use std::fmt::Write as _;

pub use serde_json::Value;

/// A JSON object, in insertion order.
pub type Map = serde_json::Map<String, Value>;

/// Parses JSON text the way `JSON.parse` does. Numbers become doubles when written; see [`stringify`].
pub fn parse(text: &str) -> Result<Value, serde_json::Error> {
    serde_json::from_str(text)
}

/// Whether `key` is an array index (a canonical integer below 2³² − 1), which JavaScript orders first.
fn is_index(key: &str) -> bool {
    if key.is_empty() || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    if key.len() > 1 && key.starts_with('0') {
        return false;
    }
    key.parse::<u64>().is_ok_and(|n| n < 4_294_967_295)
}

/// The keys of `map` in JavaScript property order.
pub fn keys(map: &Map) -> Vec<&String> {
    let mut indices: Vec<&String> = map.keys().filter(|k| is_index(k)).collect();
    if indices.is_empty() {
        return map.keys().collect();
    }
    indices.sort_by_key(|k| k.parse::<u64>().unwrap_or(0));
    indices.extend(map.keys().filter(|k| !is_index(k)));
    indices
}

/// The entries of `map` in JavaScript property order.
pub fn entries(map: &Map) -> impl Iterator<Item = (&String, &Value)> {
    keys(map).into_iter().map(move |k| (k, &map[k]))
}

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, None, 0);
    out
}

/// `JSON.stringify(value, null, indent)`.
pub fn stringify_pretty(value: &Value, indent: &str) -> String {
    let mut out = String::new();
    write_value(&mut out, value, Some(indent), 0);
    out
}

fn write_value(out: &mut String, value: &Value, indent: Option<&str>, level: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number_to_string(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, level + 1);
                write_value(out, item, indent, level + 1);
            }
            newline(out, indent, level);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (key, item)) in entries(map).enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, level + 1);
                write_string(out, key);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(out, item, indent, level + 1);
            }
            newline(out, indent, level);
            out.push('}');
        }
    }
}

fn newline(out: &mut String, indent: Option<&str>, level: usize) {
    if let Some(indent) = indent {
        out.push('\n');
        for _ in 0..level {
            out.push_str(indent);
        }
    }
}

/// A JSON string literal as `JSON.stringify` writes it.
pub fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `Number.prototype.toString` for a double. Non-finite numbers are written as `null`, as `JSON.stringify` does.
pub fn number_to_string(n: f64) -> String {
    if !n.is_finite() {
        return "null".to_string();
    }
    if n == 0.0 {
        return "0".to_string();
    }
    ryu_js::Buffer::new().format_finite(n).to_string()
}

/// A JSON number from a double, or `null` when it is not finite (as `JSON.stringify` writes it).
pub fn number(n: f64) -> Value {
    serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
}

/// Compares strings by UTF-16 code units, as JavaScript's `<` and `Array.prototype.sort` do.
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `String(value)`.
pub fn to_js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f.is_nan() { "NaN".to_string() } else { number_to_string(f) }
        }
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            items.iter().map(|item| if item.is_null() { String::new() } else { to_js_string(item) }).collect::<Vec<_>>().join(",")
        }
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// The number as JavaScript holds it.
pub fn as_f64(value: &Value) -> Option<f64> {
    value.as_number().and_then(serde_json::Number::as_f64)
}

/// `typeof v === "number" && Number.isInteger(v) && v >= 0`: a count.
pub fn count(value: Option<&Value>) -> Option<f64> {
    let n = as_f64(value?)?;
    (n.is_finite() && n.fract() == 0.0 && n >= 0.0).then_some(n)
}

/// `typeof v === "number" && Number.isFinite(v)`.
pub fn amount(value: Option<&Value>) -> Option<f64> {
    as_f64(value?).filter(|n| n.is_finite())
}

/// Builds objects the way JavaScript object literals and spreads do: setting a key that exists keeps its
/// position, and `opt` skips `None` (an `undefined` property, which `compact` and `JSON.stringify` drop).
#[derive(Default, Clone, Debug)]
pub struct Obj(pub Map);

impl Obj {
    pub fn new() -> Self {
        Self(Map::new())
    }

    pub fn set(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.0.insert(key.to_string(), value.into());
        self
    }

    pub fn opt<V: Into<Value>>(mut self, key: &str, value: Option<V>) -> Self {
        if let Some(value) = value {
            self.0.insert(key.to_string(), value.into());
        }
        self
    }

    /// `{...other}`: copies every property of `other`, in JavaScript order.
    pub fn spread(mut self, other: &Map) -> Self {
        for (key, value) in entries(other) {
            self.0.insert(key.clone(), value.clone());
        }
        self
    }

    pub fn build(self) -> Map {
        self.0
    }

    pub fn value(self) -> Value {
        Value::Object(self.0)
    }
}

impl From<Obj> for Value {
    fn from(obj: Obj) -> Self {
        Value::Object(obj.0)
    }
}

/// Property access on JSON objects, with JavaScript's `typeof` checks.
pub trait Get {
    fn field(&self, key: &str) -> Option<&Value>;

    /// The property when it is a string.
    fn str(&self, key: &str) -> Option<&str> {
        self.field(key).and_then(Value::as_str)
    }
    /// The property when it is a non-empty string.
    fn nonempty(&self, key: &str) -> Option<&str> {
        self.str(key).filter(|s| !s.is_empty())
    }
    /// The property when it is an object (not an array).
    fn obj(&self, key: &str) -> Option<&Map> {
        self.field(key).and_then(Value::as_object)
    }
    fn arr(&self, key: &str) -> Option<&Vec<Value>> {
        self.field(key).and_then(Value::as_array)
    }
    fn bool(&self, key: &str) -> Option<bool> {
        self.field(key).and_then(Value::as_bool)
    }
    /// `obj.key === value` for a string `value`.
    fn is(&self, key: &str, value: &str) -> bool {
        self.str(key) == Some(value)
    }
    /// `"key" in obj`.
    fn has(&self, key: &str) -> bool {
        self.field(key).is_some()
    }
    /// `obj.key ?? fallback`: the property unless it is missing or `null`.
    fn defined(&self, key: &str) -> Option<&Value> {
        self.field(key).filter(|v| !v.is_null())
    }
}

impl Get for Map {
    fn field(&self, key: &str) -> Option<&Value> {
        self.get(key)
    }
}

impl Get for Value {
    fn field(&self, key: &str) -> Option<&Value> {
        self.as_object().and_then(|map| map.get(key))
    }
}

impl<T: Get> Get for Option<&T> {
    fn field(&self, key: &str) -> Option<&Value> {
        self.and_then(|v| v.field(key))
    }
}

/// JavaScript truthiness.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(_) => as_f64(value).is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A string value.
pub fn s(text: impl Into<String>) -> Value {
    Value::String(text.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        let v = parse("[1e21, 1e-7, 123456789012345680000, 0.30000000000000004, -0, 5e-324, 9007199254740993, 1.0, 100, 1e300]").unwrap();
        assert_eq!(stringify(&v), "[1e+21,1e-7,123456789012345680000,0.30000000000000004,0,5e-324,9007199254740992,1,100,1e+300]");
    }

    #[test]
    fn integer_keys_come_first() {
        let v = parse(r#"{"b":1,"1":2,"01":3,"4294967295":4,"4294967294":5,"a":6,"-1":7}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"1":2,"4294967294":5,"b":1,"01":3,"4294967295":4,"a":6,"-1":7}"#);
    }

    #[test]
    fn strings_escape_what_json_stringify_escapes() {
        let v = s("\u{0}\u{1f}\u{7f}\u{2028}é😀\"\\/\u{8}\u{c}\n\r\t");
        assert_eq!(stringify(&v), "\"\\u0000\\u001f\u{7f}\u{2028}é😀\\\"\\\\/\\b\\f\\n\\r\\t\"");
    }

    #[test]
    fn pretty_printing_matches() {
        let v = parse(r#"{"a":[],"b":{},"c":[1,{"d":null}]}"#).unwrap();
        assert_eq!(
            stringify_pretty(&v, "  "),
            "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1,\n    {\n      \"d\": null\n    }\n  ]\n}"
        );
    }

    #[test]
    fn utf16_order() {
        let mut v = vec!["😀", "\u{ffff}", "z", "é"];
        v.sort_by(|a, b| cmp_utf16(a, b));
        assert_eq!(v, vec!["z", "é", "😀", "\u{ffff}"]);
    }
}
